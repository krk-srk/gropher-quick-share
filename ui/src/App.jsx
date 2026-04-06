import React, { useState, useEffect, useRef } from 'react';
import { 
  Send, Download, Shield, RefreshCw, 
  ShieldCheck, LogOut, Lock, HardDrive, Folder, Loader2, Check, Zap, Trash2, File, X, FilePlus
} from 'lucide-react';

// Persist Peer ID so the signaling server recognizes us after a refresh
const getSavedPeerId = () => {
  let id = sessionStorage.getItem('gopher_peer_id');
  if (!id) {
    id = Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('gopher_peer_id', id);
  }
  return id;
};

const MY_PEER_ID = getSavedPeerId();
const CHUNK_SIZE = 16384; 
const BUFFER_THRESHOLD = 65535; // 64KB threshold for flow control

const App = () => {
  // Initialize state from SessionStorage to handle page refreshes
  const [roomId, setRoomId] = useState(() => sessionStorage.getItem('gopher_room_id') || '');
  const [passkey, setPasskey] = useState(() => sessionStorage.getItem('gopher_passkey') || '');
  const [isSender, setIsSender] = useState(() => sessionStorage.getItem('gopher_is_sender') !== 'false');
  
  const [inRoom, setInRoom] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [files, setFiles] = useState([]);
  const [progress, setProgress] = useState(0);
  const [transferring, setTransferring] = useState(false);
  const [receivedFiles, setReceivedFiles] = useState([]);

  const socket = useRef(null);
  const pc = useRef(null);
  const dc = useRef(null);
  const chunks = useRef([]);
  const metadata = useRef(null);

  // Sync state changes to SessionStorage
  useEffect(() => {
    sessionStorage.setItem('gopher_room_id', roomId);
    sessionStorage.setItem('gopher_passkey', passkey);
    sessionStorage.setItem('gopher_is_sender', isSender);
  }, [roomId, passkey, isSender]);

  // Auto-reconnect logic on component mount
  useEffect(() => {
    const wasConnected = sessionStorage.getItem('gopher_was_connected') === 'true';
    if (wasConnected && roomId && passkey) {
      connectToSignaling();
    }

    return () => {
      if (socket.current) socket.current.close();
      if (pc.current) pc.current.close();
    };
  }, []);

  const getWsUrl = () => {
    let envUrl = "";
    try {
      const meta = typeof import.meta !== 'undefined' ? import.meta : {};
      const env = meta.env || {};
      if (env.VITE_WS_URL) envUrl = env.VITE_WS_URL;
    } catch (e) {}

    if (envUrl) return envUrl;

    const isHttps = window.location.protocol === 'https:';
    const protocol = isHttps ? 'wss:' : 'ws:';
    const host = window.location.hostname || 'localhost';
    
    if (host.includes('trycloudflare.com')) {
      return `${protocol}//${host}/ws`;
    }
    return `${protocol}//${host}:8080/ws`;
  };

  const BACKEND_URL = getWsUrl();

  const setupWebRTC = () => {
    pc.current = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    pc.current.onicecandidate = (e) => {
      if (e.candidate) sendSignal('candidate', JSON.stringify(e.candidate));
    };

    if (isSender) {
      dc.current = pc.current.createDataChannel("transfer", { ordered: true });
      initDataChannel(dc.current);
    } else {
      pc.current.ondatachannel = (e) => {
        dc.current = e.channel;
        initDataChannel(dc.current);
      };
    }
  };

  const initDataChannel = (channel) => {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;
    
    channel.onopen = () => {
      setStatus('P2P Secure Connection');
      sessionStorage.setItem('gopher_was_connected', 'true');
    };

    channel.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.type === 'meta') {
          metadata.current = msg;
          chunks.current = [];
          setTransferring(true);
        }
      } else {
        chunks.current.push(e.data);
        const received = chunks.current.length * CHUNK_SIZE;
        const total = metadata.current.size;
        setProgress(Math.min(100, Math.round((received / total) * 100)));
        if (received >= total) {
          const blob = new Blob(chunks.current);
          setReceivedFiles(prev => [{ 
            name: metadata.current.name, 
            url: URL.createObjectURL(blob), 
            id: Math.random().toString(36).substr(2, 9) 
          }, ...prev]);
          setTransferring(false);
          setStatus('Ready');
        }
      }
    };
  };

  const sendSignal = (type, data) => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type, roomId, peerId: MY_PEER_ID, passkey, data }));
    }
  };

  const connectToSignaling = () => {
    setStatus('Linking to Network...');
    try {
      if (socket.current) socket.current.close();
      socket.current = new WebSocket(BACKEND_URL);
      
      socket.current.onopen = () => {
        sendSignal('join');
      };
      
      socket.current.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'join-success') {
          setInRoom(true);
          setStatus('Waiting for Peer...');
          setupWebRTC();
        } else if (msg.type === 'peer-joined' && isSender) {
          const offer = await pc.current.createOffer();
          await pc.current.setLocalDescription(offer);
          sendSignal('offer', JSON.stringify(offer));
        } else if (msg.type === 'offer') {
          await pc.current.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
          const answer = await pc.current.createAnswer();
          await pc.current.setLocalDescription(answer);
          sendSignal('answer', JSON.stringify(answer));
        } else if (msg.type === 'answer') {
          await pc.current.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
        } else if (msg.type === 'candidate') {
          await pc.current.addIceCandidate(new RTCIceCandidate(JSON.parse(msg.data)));
        } else if (msg.type === 'error') {
          setStatus(`Error: ${msg.data}`);
          socket.current.close();
          sessionStorage.removeItem('gopher_was_connected');
        }
      };

      socket.current.onerror = () => setStatus('Bridge Offline');
    } catch (e) {
      setStatus('Invalid Server URL');
    }
  };

  const startTransfer = async () => {
    if (files.length === 0 || !dc.current || dc.current.readyState !== 'open') return;
    setTransferring(true);
    const queue = [...files];
    setFiles([]); 

    const waitForBuffer = async () => {
      if (dc.current.bufferedAmount > BUFFER_THRESHOLD) {
        return new Promise(resolve => {
          const handler = () => {
            dc.current.removeEventListener('bufferedamountlow', handler);
            resolve();
          };
          dc.current.addEventListener('bufferedamountlow', handler);
        });
      }
    };

    for (const f of queue) {
      dc.current.send(JSON.stringify({ type: 'meta', name: f.name, size: f.size }));
      
      await new Promise(res => {
        const reader = new FileReader();
        let offset = 0;
        const read = () => reader.readAsArrayBuffer(f.slice(offset, offset + CHUNK_SIZE));
        
        reader.onload = async (e) => {
          await waitForBuffer();
          dc.current.send(e.target.result);
          offset += e.target.result.byteLength;
          setProgress(Math.round((offset / f.size) * 100));
          if (offset < f.size) read(); else res();
        };
        read();
      });
    }
    setTransferring(false);
  };

  const generateID = () => {
    const ids = ['neon-sync', 'iron-vault', 'swift-node', 'cloud-bridge'];
    setRoomId(ids[Math.floor(Math.random() * ids.length)] + '-' + Math.floor(Math.random() * 99));
    setPasskey(Math.random().toString(36).substr(2, 4).toUpperCase());
  };

  const terminateSession = () => {
    sessionStorage.clear();
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-[#030305] text-slate-300 p-4 md:p-8 flex flex-col items-center justify-center relative overflow-hidden font-sans select-none">
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-cyan-500/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-600/10 blur-[120px] rounded-full pointer-events-none" />
      
      <div className="max-w-[440px] w-full relative z-10">
        <header className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-white/5 border border-white/10 rounded-full mb-6">
             <ShieldCheck className="w-3 h-3 text-cyan-500" />
             <span className="text-[9px] font-black tracking-widest text-slate-400 uppercase">Secure P2P Bridge</span>
          </div>
          <h1 className="text-5xl font-black italic tracking-tighter text-white uppercase leading-none">
            GOPHER<span className="text-cyan-500">.</span>
          </h1>
        </header>

        <div className="bg-slate-900/40 backdrop-blur-3xl rounded-[3rem] border border-white/5 p-6 md:p-8 shadow-2xl">
          {!inRoom ? (
            <div className="space-y-6">
              <div className="flex bg-black/40 p-1.5 rounded-2xl border border-white/5">
                <button onClick={() => setIsSender(true)} className={`flex-1 py-3 rounded-xl font-black text-[10px] transition-all ${isSender ? 'bg-white text-black shadow-lg' : 'text-slate-600'}`}>SENDER</button>
                <button onClick={() => setIsSender(false)} className={`flex-1 py-3 rounded-xl font-black text-[10px] transition-all ${!isSender ? 'bg-white text-black shadow-lg' : 'text-slate-600'}`}>RECEIVER</button>
              </div>
              <div className="space-y-4">
                <div className="space-y-1">
                   <div className="flex justify-between items-center px-1">
                      <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Bridge ID</p>
                      {isSender && (
                        <button onClick={generateID} className="text-cyan-500 text-[9px] font-black flex items-center gap-1 hover:brightness-125 transition">
                           <RefreshCw className="w-3 h-3" /> AUTO-GEN
                        </button>
                      )}
                   </div>
                   <input type="text" value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="Generate or Enter ID" className="w-full bg-black/60 border border-white/10 rounded-2xl py-4 px-6 text-cyan-400 font-mono text-lg focus:outline-none focus:border-cyan-500/30" />
                </div>
                <div className="space-y-1">
                   <p className="text-[9px] font-black text-slate-500 uppercase px-1 tracking-widest">Security Passkey</p>
                   <input type="text" value={passkey} onChange={(e) => setPasskey(e.target.value.toUpperCase())} placeholder="Security Key" className="w-full bg-black/60 border border-white/10 rounded-2xl py-4 px-6 text-white font-mono text-lg focus:outline-none" />
                </div>
              </div>
              <button onClick={connectToSignaling} className="w-full bg-white text-black py-5 rounded-3xl font-black text-xs uppercase tracking-widest active:scale-95 transition-all">Launch Bridge</button>
              <p className="text-center text-[10px] font-bold text-cyan-500 uppercase tracking-widest animate-pulse">{status}</p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between p-4 bg-black/40 rounded-2xl border border-white/5">
                 <span className="text-[10px] font-black text-slate-400 uppercase">{status}</span>
                 <span className="text-[10px] font-mono text-cyan-500/40 uppercase">{roomId}</span>
              </div>

              {isSender ? (
                <div className="space-y-4">
                  <input type="file" multiple className="hidden" id="f" onChange={(e) => setFiles([...files, ...Array.from(e.target.files)])} />
                  <label htmlFor="f" className="block border-2 border-dashed border-white/10 rounded-3xl p-10 text-center cursor-pointer hover:border-cyan-500/40 transition-all relative group">
                    <FilePlus className="w-10 h-10 text-slate-800 mx-auto mb-2 group-hover:text-cyan-500 transition-colors" />
                    <p className="text-xs font-bold text-slate-400">Add Files to Bundle ({files.length})</p>
                  </label>
                  
                  {files.length > 0 && (
                    <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1">
                      {files.map((f, i) => (
                        <div key={i} className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5">
                          <span className="text-[11px] font-bold truncate max-w-[200px]">{f.name}</span>
                          {!transferring && (
                            <button onClick={() => setFiles(files.filter((_, idx) => idx !== i))} className="p-1 text-slate-600 hover:text-red-500">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {files.length > 0 && !transferring && status.includes('Connection') && (
                    <button onClick={startTransfer} className="w-full bg-cyan-500 text-black py-4 rounded-2xl font-black text-[10px] uppercase shadow-lg active:scale-95 transition-all">Start Transmission</button>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {receivedFiles.length > 0 ? (
                    <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                      {receivedFiles.map((f, i) => (
                        <div key={f.id || i} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5 group">
                          <div className="flex items-center gap-4 overflow-hidden">
                             <div className="w-10 h-10 bg-green-500/10 rounded-xl flex items-center justify-center border border-green-500/20"><Check className="w-5 h-5 text-green-500" /></div>
                             <span className="text-[11px] font-bold text-slate-200 truncate">{f.name}</span>
                          </div>
                          <a href={f.url} download={f.name} className="p-3 bg-white text-black rounded-xl hover:bg-cyan-50 active:scale-90 transition-all"><Download className="w-4 h-4" /></a>
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-center py-10 space-y-4 border border-dashed border-white/5 rounded-3xl">
                        <Loader2 className="w-10 h-10 mx-auto text-slate-900 animate-spin" />
                        <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest">Awaiting Payload...</p>
                      </div>}
                </div>
              )}

              {transferring && (
                <div className="space-y-2 bg-black/40 p-4 rounded-2xl border border-white/5">
                  <div className="flex justify-between items-center text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">
                    <span className="truncate max-w-[70%]">Streaming Data</span>
                    <span className="text-cyan-500">{progress}%</span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-cyan-500 transition-all duration-300" style={{ width: `${progress}%` }}></div>
                  </div>
                </div>
              )}
              
              <button onClick={terminateSession} className="w-full py-4 bg-red-500/5 hover:bg-red-500/10 border border-red-500/20 text-red-500 rounded-2xl font-black text-[10px] uppercase transition-all flex items-center justify-center gap-2 leading-none">
                <LogOut className="w-4 h-4" /> Terminate Session
              </button>
            </div>
          )}
        </div>

        <div className="mt-10 flex justify-center items-center gap-10 opacity-20 text-[8px] font-black uppercase tracking-[0.2em] text-slate-500">
          <div className="flex items-center gap-2"><Shield className="w-3 h-3" /> E2E Encrypted</div>
          <div className="flex items-center gap-2"><HardDrive className="w-3 h-3" /> Peer-To-Peer</div>
        </div>
      </div>
    </div>
  );
};

export default App;
