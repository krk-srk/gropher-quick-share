import React, { useState, useEffect, useRef } from 'react';
import { 
  Send, Download, Shield, RefreshCw, 
  ShieldCheck, LogOut, Lock, HardDrive, Folder, Loader2, Check, Trash2, File, Settings, FilePlus, AlertCircle, Users, Activity, Globe, User, Share2, PlusCircle, QrCode, Copy, X, Link as LinkIcon, Pause, Play, Ban, AlertTriangle, Clock, MessageSquare, SendHorizontal, Zap, Mic, Video, Phone, PhoneOff, Minimize2, Maximize2, MicOff, VideoOff, Sparkles, BrainCircuit, Wand2, Paperclip, ChevronRight, Hash, Hourglass
} from 'lucide-react';

const CHUNK_SIZE = 16384; 
const BUFFER_THRESHOLD = 65536;

const getPersistentPeerId = () => {
  try {
    let id = sessionStorage.getItem('gd_peer_id');
    if (!id) {
      id = Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem('gd_peer_id', id);
    }
    return id;
  } catch (e) { return Math.random().toString(36).substr(2, 9); }
};

const MY_PEER_ID = getPersistentPeerId();

const App = () => {
  const getUrlParams = () => {
    try {
      const params = new URLSearchParams(window.location.search);
      return { room: params.get('portal'), key: params.get('key') };
    } catch (e) { return { room: null, key: null }; }
  };

  const urlParams = getUrlParams();

  // --- Core App State ---
  const [username, setUsername] = useState(() => sessionStorage.getItem('gd_user') || '');
  const [roomId, setRoomId] = useState(() => (urlParams.room || sessionStorage.getItem('gd_room') || '').toLowerCase().trim());
  const [passkey, setPasskey] = useState(() => (urlParams.key || sessionStorage.getItem('gd_pass') || '').toUpperCase().trim());
  const [entryMode, setEntryMode] = useState(() => urlParams.room ? 'join' : (sessionStorage.getItem('gd_mode') || 'host')); 
  const [portalLife, setPortalLife] = useState(60); 
  
  const [inRoom, setInRoom] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(null);
  const [showPeers, setShowPeers] = useState(false);
  
  // Mesh Data
  const [peers, setPeers] = useState({}); 
  const [sharedFiles, setSharedFiles] = useState([]); 
  const [receivedFiles, setReceivedFiles] = useState([]); 
  const [messages, setMessages] = useState(() => JSON.parse(sessionStorage.getItem('gd_chat') || '[]'));
  const [chatInput, setChatInput] = useState('');

  // Media Call States
  const [inCall, setInCall] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({}); 
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  
  // Transfer States
  const [transferProgress, setTransferProgress] = useState(0);
  const [isTransferring, setIsTransferring] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [activeFileName, setActiveFileName] = useState('');

  // WebRTC Refs
  const socket = useRef(null);
  const peerConnections = useRef({}); 
  const dataChannels = useRef({}); 
  const iceQueues = useRef({});
  const sharedFilesRef = useRef([]);
  const localStreamRef = useRef(null); 
  const chatEndRef = useRef(null);
  const transferControl = useRef({ cancelled: false, paused: false });
  const receivingTransferState = useRef({}); 
  const localVideoRef = useRef(null);
  const heartbeatRef = useRef(null);

  // --- Persistence & Sync ---

  useEffect(() => { 
    sharedFilesRef.current = sharedFiles;
    try {
      const meta = sharedFiles.map(f => ({ name: f.name, size: f.size, reattachNeeded: !f.slice }));
      sessionStorage.setItem('gd_shared_meta', JSON.stringify(meta));
    } catch(e) {}
  }, [sharedFiles]);

  useEffect(() => {
    sessionStorage.setItem('gd_chat', JSON.stringify(messages));
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    try {
      sessionStorage.setItem('gd_user', username);
      sessionStorage.setItem('gd_room', roomId);
      sessionStorage.setItem('gd_pass', passkey);
      sessionStorage.setItem('gd_mode', entryMode);
    } catch (e) {}
  }, [username, roomId, passkey, entryMode]);

  useEffect(() => {
    const wasInPortal = sessionStorage.getItem('gd_in_portal') === 'true';
    const savedMeta = sessionStorage.getItem('gd_shared_meta');
    if (savedMeta) {
      try { 
        const list = JSON.parse(savedMeta);
        setSharedFiles(list.map(f => ({ ...f, reattachNeeded: true }))); 
      } catch(e) {}
    }
    if (wasInPortal && roomId && passkey && username) launchBridge();
    return () => {
      if (socket.current) socket.current.close();
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      Object.values(peerConnections.current).forEach(pc => pc.close());
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  // --- Utilities ---

  const getWsUrl = () => {
    const isHttps = window.location.protocol === 'https:';
    const hostname = window.location.hostname || 'localhost';
    const protocol = isHttps ? 'wss:' : 'ws:';
    if (hostname.includes('scf.usercontent.goog') || hostname.includes('trycloudflare.com')) return `${protocol}//${hostname}/ws`;
    return `${protocol}//${hostname}:8080/ws`;
  };

  const robustCopy = (text, type) => {
    const el = document.createElement("textarea"); el.value = text; document.body.appendChild(el); el.select();
    document.execCommand('copy'); document.body.removeChild(el);
    setCopyFeedback(type); setTimeout(() => setCopyFeedback(null), 2000);
  };

  // --- Handshake & Messaging ---

  const sendSignal = (type, data = {}, targetId = "") => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ 
        type, roomId: roomId.toLowerCase().trim(), peerId: MY_PEER_ID, username, 
        passkey: passkey.toUpperCase().trim(), data, targetId, isSender: entryMode === 'host',
        ttl: portalLife
      }));
    }
  };

  const startHeartbeat = () => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = setInterval(() => {
      if (socket.current?.readyState === WebSocket.OPEN) sendSignal('ping');
    }, 25000);
  };

  const broadcastMetadata = (list = null) => {
    const items = (list || sharedFilesRef.current).filter(f => !f.reattachNeeded);
    const meta = items.map(f => ({ name: f.name, size: f.size, ownerId: MY_PEER_ID, ownerName: username || 'Peer' }));
    sendSignal('metadata-update', meta);
  };

  const initDataChannel = (targetId, channel) => {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;
    channel.onopen = () => setPeers(prev => ({ ...prev, [targetId]: { ...prev[targetId], status: 'connected' } }));
    
    channel.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.type === 'file-meta') {
          receivingTransferState.current[targetId] = { chunks: [], meta: msg, receivedBytes: 0 };
          setIsTransferring(true);
          setTransferProgress(0);
          setActiveFileName(msg.name);
        }
      } else {
        const state = receivingTransferState.current[targetId];
        if (!state || transferControl.current.cancelled) return;
        state.chunks.push(e.data);
        state.receivedBytes += e.data.byteLength;
        const total = state.meta.size;
        setTransferProgress(Math.min(100, Math.round((state.receivedBytes / total) * 100)));
        
        if (state.receivedBytes >= total) {
          const blob = new Blob(state.chunks);
          const url = URL.createObjectURL(blob);
          setReceivedFiles(prev => [{ name: state.meta.name, url, id: Math.random().toString(36).substr(2, 9) }, ...prev]);
          
          // CRITICAL FIX: Clear memory chunks and reset global flags to prevent hanging
          state.chunks = []; 
          delete receivingTransferState.current[targetId];
          setIsTransferring(false);
          setActiveFileName('');
          setTransferProgress(0);
          setStatus('Transfer Complete');
        }
      }
    };
    dataChannels.current[targetId] = channel;
  };

  const createPeerConnection = (targetId, initiate = false) => {
    if (peerConnections.current[targetId]) return peerConnections.current[targetId];
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
    iceQueues.current[targetId] = [];
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));
    pc.ontrack = (e) => setRemoteStreams(prev => ({ ...prev, [targetId]: e.streams[0] }));
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal('candidate', e.candidate, targetId); };
    pc.oniceconnectionstatechange = () => setPeers(prev => ({ ...prev, [targetId]: { ...prev[targetId], status: pc.iceConnectionState } }));
    
    if (initiate) {
      const dc = pc.createDataChannel("transfer", { ordered: true });
      initDataChannel(targetId, dc);
      pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => sendSignal('offer', pc.localDescription, targetId));
    } else {
      pc.ondatachannel = (e) => initDataChannel(targetId, e.channel);
    }
    peerConnections.current[targetId] = pc;
    return pc;
  };

  const launchBridge = () => {
    if (!roomId || !passkey || !username) return setErrorMessage('Coordinates required');
    setLoading(true); setErrorMessage('');
    if (socket.current) socket.current.close();
    const wsUrl = getWsUrl();
    socket.current = new WebSocket(wsUrl);
    socket.current.onopen = () => { sendSignal('join'); startHeartbeat(); };
    socket.current.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'join-success': setInRoom(true); setLoading(false); setStatus('Online'); sessionStorage.setItem('gd_in_portal', 'true'); break;
        case 'peer-joined':
          if (MY_PEER_ID !== msg.PeerID) {
            if (MY_PEER_ID > msg.PeerID) createPeerConnection(msg.PeerID, true);
            setPeers(prev => ({ ...prev, [msg.PeerID]: { username: msg.Username || 'Peer', status: 'handshaking' }}));
            setTimeout(() => broadcastMetadata(), 1500);
          }
          break;
        case 'chat': setMessages(prev => [...prev, { ...msg.data, text: String(msg.data.text || ''), isMe: false }]); break;
        case 'request-file': handleFileUploadRequest(msg.data.fileName, msg.peerId); break;
        case 'offer':
          const pcOffer = createPeerConnection(msg.peerId, false);
          if (pcOffer.signalingState === "stable" || pcOffer.signalingState === "have-local-offer") {
            try {
              await pcOffer.setRemoteDescription(new RTCSessionDescription(msg.data));
              const answer = await pcOffer.createAnswer();
              await pcOffer.setLocalDescription(answer);
              sendSignal('answer', pcOffer.localDescription, msg.peerId);
              const q = iceQueues.current[msg.peerId] || [];
              while (q.length > 0) await pcOffer.addIceCandidate(q.shift());
            } catch (err) {}
          }
          break;
        case 'answer':
          const pcAns = peerConnections.current[msg.peerId];
          if (pcAns) {
            await pcAns.setRemoteDescription(new RTCSessionDescription(msg.data));
            const q = iceQueues.current[msg.peerId] || [];
            while (q.length > 0) await pcAns.addIceCandidate(q.shift());
          }
          break;
        case 'candidate':
          const pcC = peerConnections.current[msg.peerId];
          const cand = new RTCIceCandidate(msg.data);
          if (pcC && pcC.remoteDescription) await pcC.addIceCandidate(cand);
          else { if (!iceQueues.current[msg.peerId]) iceQueues.current[msg.peerId] = []; iceQueues.current[msg.peerId].push(cand); }
          break;
        case 'portal-terminate': terminatePortal(true); break; 
        case 'peer-left':
          if (peerConnections.current[msg.PeerID]) peerConnections.current[msg.PeerID].close();
          delete peerConnections.current[msg.PeerID];
          setPeers(prev => { const n = { ...prev }; delete n[msg.PeerID]; return n; });
          setRemoteStreams(prev => { const n = {...prev}; delete n[msg.PeerID]; return n; });
          break;
        case 'error': setErrorMessage(msg.data); setLoading(false); break;
        default: break;
      }
    };
  };

  // --- Call/Media Logic ---

  const startMedia = async (type) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' });
      localStreamRef.current = stream; setLocalStream(stream); setInCall(true);
      if (localVideoRef.current && type === 'video') localVideoRef.current.srcObject = stream;
      Object.values(peerConnections.current).forEach(pc => stream.getTracks().forEach(track => pc.addTrack(track, stream)));
      Object.keys(peerConnections.current).forEach(async (pid) => {
        const pc = peerConnections.current[pid];
        try { const o = await pc.createOffer(); await pc.setLocalDescription(o); sendSignal('offer', pc.localDescription, pid); } catch (e) {}
      });
    } catch (err) { setErrorMessage("Media denied."); }
  };

  const stopMedia = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setInCall(false);
    setRemoteStreams({});
    window.location.reload();
  };

  // --- File & Messaging Logic ---

  const handleFileUploadRequest = async (fileName, targetId) => {
    const file = sharedFilesRef.current.find(f => f.name === fileName);
    const dc = dataChannels.current[targetId];
    
    if (!dc || dc.readyState !== 'open') {
      createPeerConnection(targetId, true);
      return;
    }

    if (!file || !file.slice) return;
    
    setIsTransferring(true); 
    setActiveFileName(file.name);
    transferControl.current.cancelled = false;
    transferControl.current.paused = false;

    dc.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size }));
    
    let offset = 0;
    const reader = new FileReader();
    
    const readNext = () => {
      if (transferControl.current.cancelled) { setIsTransferring(false); return; }
      if (transferControl.current.paused) { setTimeout(readNext, 200); return; }
      
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = async (e) => {
      if (dc.bufferedAmount > BUFFER_THRESHOLD) {
        await new Promise(r => { 
          const h = () => { dc.removeEventListener('bufferedamountlow', h); r(); }; 
          dc.addEventListener('bufferedamountlow', h); 
        });
      }

      try {
        dc.send(e.target.result);
        offset += e.target.result.byteLength;
        setTransferProgress(Math.round((offset / file.size) * 100));

        if (offset < file.size) {
          setTimeout(readNext, 0); 
        } else {
          // CRITICAL FIX: Reset flags and active state for sender
          setIsTransferring(false);
          setActiveFileName('');
          setTransferProgress(0);
          setStatus('Ready');
        }
      } catch (err) {
        console.error("Transfer Failed:", err);
        setIsTransferring(false);
      }
    };

    readNext();
  };

  const requestDownload = (fileName, ownerId) => {
    // Check if system is busy to prevent overlapping streams causing hangs
    if (isTransferring) {
      setStatus("Queue Busy: Please wait...");
      return;
    }

    const dc = dataChannels.current[ownerId];
    if (!dc || dc.readyState !== 'open') {
        setStatus("Refreshing tunnel...");
        createPeerConnection(ownerId, true);
        setTimeout(() => sendSignal('request-file', { fileName }, ownerId), 1000);
    } else {
        sendSignal('request-file', { fileName }, ownerId);
        setStatus(`Requesting payload...`);
    }
  };

  const sendChatMessage = (e) => {
    e?.preventDefault(); if (!chatInput.trim()) return;
    const msg = { text: chatInput, sender: username, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), isMe: true, type: 'text' };
    setMessages(prev => [...prev, msg]); sendSignal('chat', msg); setChatInput('');
  };

  const sendFileInChat = (e) => {
    const files = Array.from(e.target.files); if (files.length === 0) return;
    const updated = [...sharedFiles, ...files]; setSharedFiles(updated);
    files.forEach(f => {
      const msg = { type: 'file', name: f.name, size: f.size, sender: username, ownerId: MY_PEER_ID, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), isMe: true };
      setMessages(prev => [...prev, msg]); sendSignal('chat', msg);
    });
    setTimeout(() => broadcastMetadata(updated), 500);
  };

  const terminatePortal = (forced = false) => {
    if (entryMode === 'host' && !forced) sendSignal('portal-terminate');
    sessionStorage.clear();
    window.location.reload();
  };

  const joinUrl = `${window.location.origin}${window.location.pathname}?portal=${roomId}&key=${passkey}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(joinUrl)}&format=svg`;

  return (
    <div className="min-h-screen bg-[#030305] text-slate-300 flex flex-col font-sans overflow-x-hidden selection:bg-cyan-500/30">
      <div className="absolute top-[-20%] left-[-10%] w-[70%] h-[70%] bg-cyan-900/10 blur-[160px] rounded-full pointer-events-none" />
      
      {/* NAVBAR */}
      <nav className="sticky top-0 z-[100] w-full border-b border-white/5 bg-[#030305]/80 backdrop-blur-2xl px-6 py-4 flex items-center justify-between">
         <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-cyan-500 rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(6,182,212,0.3)]">
               <Zap size={22} className="text-black fill-black" />
            </div>
            <div className="flex flex-col">
               <h1 className="text-xl font-black italic tracking-tighter text-white leading-none uppercase">GOPHER<span className="text-cyan-500">.</span>PRO</h1>
               <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">P2P Mesh Network</span>
            </div>
         </div>

         {inRoom && (
           <div className="flex items-center gap-3">
              <button onClick={() => setShowPeers(!showPeers)} className="p-2.5 bg-white/5 border border-white/10 rounded-xl relative hover:bg-white/10 transition-all">
                 <Users size={18} />
                 <span className="absolute -top-1 -right-1 bg-green-500 text-black text-[8px] font-black px-1.5 rounded-full">{Object.keys(peers).length + 1}</span>
              </button>
              <button onClick={() => setShowShareModal(true)} className="p-2.5 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-all">
                 <Share2 size={18} />
              </button>
              <button onClick={() => terminatePortal(false)} className={`p-2.5 rounded-xl transition-all ${entryMode === 'host' ? 'bg-red-500/10 border border-red-500/20 text-red-500 hover:bg-red-500/20' : 'bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10'}`}>
                 <LogOut size={18} />
              </button>
           </div>
         )}
      </nav>

      <main className="flex-1 flex flex-col items-center justify-center p-4 relative z-10 w-full max-w-[1400px] mx-auto h-full">
         {!inRoom ? (
           <div className="w-full max-w-[480px] space-y-8 animate-in fade-in slide-in-from-bottom-8">
              <div className="text-center space-y-2">
                 <h2 className="text-4xl font-black text-white tracking-tighter uppercase leading-none">Command Center</h2>
                 <p className="text-xs text-slate-500 font-medium tracking-wide">Enter coordinates to synchronize your direct tunnel.</p>
              </div>

              <div className="bg-slate-900/40 backdrop-blur-3xl p-8 rounded-[3.5rem] border border-white/5 shadow-2xl space-y-8 ring-1 ring-white/10">
                 <div className="flex bg-black/40 p-1.5 rounded-2xl border border-white/5">
                    <button onClick={() => setEntryMode('host')} className={`flex-1 py-3.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${entryMode === 'host' ? 'bg-white text-black shadow-xl' : 'text-slate-600 hover:text-slate-400'}`}>HOST</button>
                    <button onClick={() => { setEntryMode('join'); setRoomId(''); setPasskey(''); }} className={`flex-1 py-3.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${entryMode === 'join' ? 'bg-white text-black shadow-xl' : 'text-slate-600 hover:text-slate-400'}`}>JOIN</button>
                 </div>

                 <div className="space-y-5">
                    <div className="space-y-1.5 px-2">
                       <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Identity</label>
                       <div className="relative group">
                          <User className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-600 group-focus-within:text-cyan-500 transition-colors" />
                          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Alias" className="w-full bg-black/60 border border-white/10 rounded-2xl py-4 pl-12 pr-6 text-white font-bold focus:outline-none focus:border-cyan-500/40 transition-all placeholder:text-slate-800" />
                       </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                       <div className="space-y-1.5 px-2">
                          <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Portal ID</label>
                          <div className="relative group">
                             <Hash className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-600" />
                             <input type="text" value={roomId} onChange={e => setRoomId(e.target.value.toLowerCase())} readOnly={entryMode === 'host'} placeholder="room-code" className="w-full bg-black/60 border border-white/10 rounded-2xl py-4 pl-12 pr-6 text-cyan-400 font-mono text-sm focus:outline-none focus:border-cyan-500/40 transition-all" />
                             {entryMode === 'host' && <button onClick={() => setRoomId(`vault-${Math.floor(Math.random() * 9999)}`)} className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-slate-600 hover:text-cyan-50 transition-colors"><RefreshCw size={14}/></button>}
                          </div>
                       </div>
                       <div className="space-y-1.5 px-2">
                          <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Passkey</label>
                          <div className="relative group">
                             <Lock className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-600" />
                             <input type="text" value={passkey} onChange={e => setPasskey(e.target.value.toUpperCase())} readOnly={entryMode === 'host'} placeholder="Key" className="w-full bg-black/60 border border-white/10 rounded-2xl py-4 pl-12 pr-6 text-white font-mono text-sm focus:outline-none focus:border-cyan-500/40 transition-all" />
                             {entryMode === 'host' && <button onClick={() => setPasskey(Math.random().toString(36).substr(2,6).toUpperCase())} className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-slate-600 hover:text-cyan-50 transition-colors"><RefreshCw size={14}/></button>}
                          </div>
                       </div>
                    </div>

                    {entryMode === 'host' && (
                       <div className="space-y-2 px-2 animate-in fade-in">
                          <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Hourglass size={12}/> Portal Duration</label>
                          <div className="flex gap-2">
                             {[10, 30, 60, 1440].map(mins => (
                               <button 
                                 key={mins}
                                 onClick={() => setPortalLife(mins)}
                                 className={`flex-1 py-2 rounded-xl text-[9px] font-black border transition-all ${portalLife === mins ? 'bg-cyan-500 border-cyan-400 text-black shadow-[0_0_10px_rgba(6,182,212,0.3)]' : 'bg-black/20 border-white/5 text-slate-500'}`}
                               >
                                 {mins === 1440 ? '24H' : `${mins}M`}
                               </button>
                             ))}
                          </div>
                       </div>
                    )}
                 </div>

                 <button disabled={loading} onClick={launchBridge} className="w-full bg-white text-black py-5 rounded-3xl font-black text-sm uppercase tracking-widest active:scale-95 transition-all shadow-[0_20px_50px_rgba(255,255,255,0.15)] flex justify-center items-center gap-3 hover:shadow-cyan-500/10">
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Shield size={18} /> INITIALIZE MESH</>}
                 </button>
                 
                 {errorMessage && <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-500 text-[10px] font-black uppercase text-center">{errorMessage}</div>}
              </div>
           </div>
         ) : (
           <div className="w-full max-w-[1200px] grid grid-cols-1 lg:grid-cols-12 gap-6 h-full items-start animate-in fade-in duration-700">
              
              {/* SIDEBAR */}
              <div className="hidden lg:block lg:col-span-3 space-y-6">
                 <div className="bg-slate-900/40 border border-white/5 rounded-[2.5rem] p-6 shadow-xl backdrop-blur-xl ring-1 ring-white/5">
                    <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-6 flex justify-between">Mesh Nodes <span>{Object.keys(peers).length + 1} LIVE</span></h3>
                    <div className="space-y-2">
                       <div className="flex items-center gap-3 bg-white/5 p-4 rounded-2xl border border-cyan-500/20 shadow-lg shadow-cyan-500/5 group">
                          <div className="w-10 h-10 rounded-xl bg-cyan-500 flex items-center justify-center text-black font-black text-xs">ME</div>
                          <div className="flex flex-col overflow-hidden">
                             <span className="text-xs font-bold text-white truncate">{username}</span>
                             <span className="text-[7px] font-black text-cyan-500 uppercase">Uplink Primary</span>
                          </div>
                       </div>
                       {Object.entries(peers).map(([id, p]) => (
                         <div key={id} className="flex items-center gap-3 bg-black/20 p-4 rounded-2xl border border-white/5 transition-all hover:bg-white/5">
                            <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400 font-black text-xs uppercase">{p.username?.charAt(0)}</div>
                            <div className="flex flex-col">
                               <span className="text-xs font-bold text-slate-300 truncate max-w-[120px]">{p.username}</span>
                               <span className={`text-[7px] font-black uppercase ${p.status === 'connected' ? 'text-green-500' : 'text-yellow-500 animate-pulse'}`}>{p.status || 'Syncing'}</span>
                            </div>
                         </div>
                       ))}
                    </div>
                 </div>

                 {receivedFiles.length > 0 && (
                   <div className="bg-slate-900/40 border border-white/5 rounded-[2.5rem] p-6 shadow-xl backdrop-blur-xl animate-in fade-in">
                      <h3 className="text-[10px] font-black text-green-500 uppercase tracking-widest mb-4">Payloads Ready</h3>
                      <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1 custom-scrollbar">
                         {receivedFiles.map(f => (
                           <div key={f.id} className="flex items-center justify-between p-3 bg-black/40 rounded-xl border border-white/5 group hover:border-green-500/30 transition-all">
                              <span className="text-[10px] font-bold text-slate-300 truncate max-w-[100px]">{f.name}</span>
                              <a href={f.url} download={f.name} className="p-1.5 bg-white text-black rounded-lg hover:bg-cyan-50 transition-all"><Download size={12}/></a>
                           </div>
                         ))}
                      </div>
                   </div>
                 )}
              </div>

              {/* MAIN COMMAND CENTER */}
              <div className="lg:col-span-9 flex flex-col h-[80vh] lg:h-[700px] w-full">
                 <div className="bg-slate-900/40 rounded-[3.5rem] border border-white/10 shadow-2xl flex flex-col flex-1 overflow-hidden backdrop-blur-3xl ring-1 ring-white/10">
                    <div className="p-5 border-b border-white/5 flex items-center justify-between bg-black/20">
                       <div className="flex items-center gap-4">
                          <div className="flex flex-col">
                             <div className="flex items-center gap-2">
                                <span className="text-sm font-black text-white uppercase tracking-widest">/{roomId}</span>
                                <span className="bg-green-500/20 text-green-500 text-[8px] px-2 py-0.5 rounded-full font-black tracking-widest uppercase shadow-[0_0_8px_rgba(34,197,94,0.3)]">SECURE</span>
                             </div>
                             <div className="flex items-center gap-2 text-[8px] font-bold text-slate-500 uppercase tracking-widest px-0.5">End-to-End P2P Routing Active</div>
                          </div>
                       </div>
                       
                       <div className="flex items-center gap-2">
                          <button onClick={() => startMedia('audio')} className="p-2.5 text-slate-400 hover:text-cyan-500 hover:bg-white/5 rounded-xl transition-all" title="Audio Only"><Mic size={20} /></button>
                          <button onClick={() => startMedia('video')} className="p-2.5 text-slate-400 hover:text-cyan-500 hover:bg-white/5 rounded-xl transition-all" title="Video Uplink"><Video size={20} /></button>
                       </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-black/10">
                       {messages.length === 0 ? (
                          <div className="h-full flex flex-col items-center justify-center text-center opacity-10 space-y-6">
                             <div className="w-24 h-24 rounded-[2.5rem] border-2 border-dashed border-cyan-500 flex items-center justify-center shadow-inner"><MessageSquare size={48} className="text-cyan-500" /></div>
                             <p className="text-lg font-black uppercase tracking-widest text-white tracking-tighter">Tunnel Synchronization Clear</p>
                          </div>
                       ) : messages.map((m, i) => (
                          <div key={i} className={`flex flex-col ${m.isMe ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-4 duration-300`}>
                             <div className={`flex items-center gap-2 mb-2 px-1 ${m.isMe ? 'flex-row-reverse' : ''}`}>
                                <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-[9px] font-black ${m.isMe ? 'bg-white text-black' : 'bg-cyan-500 text-black'}`}>{m.sender?.charAt(0)}</div>
                                <span className={`text-[8px] font-black uppercase tracking-widest ${m.isMe ? 'text-slate-600' : 'text-cyan-500'}`}>{m.isMe ? 'Master' : m.sender}</span>
                                <span className="text-[7px] text-slate-800 font-mono opacity-40">{m.time}</span>
                             </div>
                             
                             {m.type === 'file' ? (
                               <div className={`max-w-[90%] md:max-w-[70%] p-4 rounded-[2rem] flex items-center gap-4 border shadow-2xl transition-all hover:scale-[1.01] ${m.isMe ? 'bg-cyan-600 text-white border-cyan-400' : 'bg-white/5 text-slate-300 border-white/10'}`}>
                                  <div className="w-12 h-12 rounded-2xl bg-black/20 flex items-center justify-center shrink-0 shadow-inner"><File size={24} /></div>
                                  <div className="flex flex-col overflow-hidden flex-1">
                                     <span className="text-sm font-black truncate">{m.name}</span>
                                     <span className="text-[9px] opacity-70 uppercase font-mono tracking-tighter">{(m.size/1024/1024).toFixed(2)} MB • MESH BLOB</span>
                                  </div>
                                  {!m.isMe && (
                                    <button 
                                      onClick={() => requestDownload(m.name, m.ownerId)} 
                                      disabled={isTransferring}
                                      className="p-3 bg-white text-black rounded-2xl hover:bg-cyan-50 active:scale-90 shadow-lg shrink-0 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                       {isTransferring && activeFileName === m.name ? <Hourglass size={20} className="animate-pulse" /> : <Download size={20} />}
                                    </button>
                                  )}
                               </div>
                             ) : (
                               <div className={`max-w-[90%] md:max-w-[75%] p-4 rounded-[2rem] text-sm leading-relaxed shadow-xl border ${m.isMe ? 'bg-white text-black font-semibold border-white/20 shadow-white/5' : 'bg-white/5 text-slate-200 border-white/5'}`}>
                                   {m.text}
                               </div>
                             )}
                          </div>
                       ))}
                       <div ref={chatEndRef} />
                    </div>

                    <div className="p-6 bg-black/40 border-t border-white/5">
                       <div className="flex gap-4 items-center max-w-[800px] mx-auto">
                          <form onSubmit={sendChatMessage} className="flex-1 flex gap-3 bg-black/60 border border-white/10 p-2 rounded-[2.5rem] focus-within:border-cyan-500/40 transition-all shadow-inner">
                             <label className="p-3 text-slate-500 hover:text-cyan-500 cursor-pointer transition-all active:scale-90 flex items-center justify-center">
                                <Paperclip size={24} />
                                <input type="file" multiple className="hidden" onChange={sendFileInChat} />
                             </label>
                             <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder="Whisper coordinate or message..." className="flex-1 bg-transparent border-none py-3 text-sm text-white focus:outline-none placeholder:text-slate-800 font-medium" />
                             <button type="submit" className="p-4 bg-white text-black rounded-[2rem] active:scale-90 transition-all hover:bg-cyan-50 shadow-xl flex items-center justify-center shadow-white/5">
                                <SendHorizontal size={22} />
                             </button>
                          </form>
                       </div>
                    </div>
                 </div>
              </div>
           </div>
         )}
      </main>

      {/* CALL OVERLAY */}
      {inCall && (
        <div className="fixed inset-0 z-[500] bg-black/98 backdrop-blur-3xl flex flex-col items-center justify-center animate-in fade-in">
           <div className="w-full h-full max-w-[1000px] flex flex-col p-8 space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
                 <div className="relative bg-white/5 rounded-[3.5rem] border border-white/10 overflow-hidden shadow-2xl group transition-all hover:ring-1 hover:ring-cyan-500/20">
                    <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover grayscale-[20%]" />
                    <div className="absolute bottom-8 left-8 bg-black/60 px-5 py-2.5 rounded-full text-[11px] font-black uppercase text-cyan-500 border border-cyan-500/20 backdrop-blur-md">Uplink Master (Me)</div>
                 </div>
                 <div className="bg-black/40 rounded-[3.5rem] border border-dashed border-white/10 flex items-center justify-center relative overflow-hidden">
                    {Object.entries(remoteStreams).map(([pid, stream]) => (
                        <video key={pid} autoPlay playsInline className="w-full h-full object-cover" ref={el => { if(el) el.srcObject = stream; }} />
                    ))}
                    {Object.entries(remoteStreams).length === 0 && (
                      <div className="text-center space-y-6 opacity-20">
                         <Loader2 size={48} className="animate-spin mx-auto text-cyan-500" />
                         <p className="text-sm font-black uppercase tracking-[0.4em]">Bridging remote nodes...</p>
                      </div>
                    )}
                 </div>
              </div>
              <div className="flex items-center justify-center gap-8 pb-12">
                 <button onClick={() => { if(localStreamRef.current) { const t = localStreamRef.current.getAudioTracks()[0]; t.enabled = !t.enabled; setIsMicMuted(!t.enabled); }}} className={`w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-2xl ${isMicMuted ? 'bg-red-500 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10 border border-white/10'}`}>{isMicMuted ? <MicOff size={32} /> : <Mic size={32} />}</button>
                 <button onClick={stopMedia} className="w-32 h-20 rounded-[2.5rem] bg-red-600 text-white flex items-center justify-center shadow-2xl shadow-red-600/40 hover:bg-red-500 active:scale-95 transition-all"><PhoneOff size={36} /></button>
                 <button onClick={() => { if(localStreamRef.current) { const t = localStreamRef.current.getVideoTracks()[0]; if(t) { t.enabled = !t.enabled; setIsVideoOff(!t.enabled); } }}} className={`w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-2xl ${isVideoOff ? 'bg-red-500 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10 border border-white/10'}`}>{isVideoOff ? <VideoOff size={32} /> : <Video size={32} />}</button>
              </div>
           </div>
        </div>
      )}

      {/* SHARE MODAL */}
      {showShareModal && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-black/90 backdrop-blur-2xl animate-in fade-in">
           <div className="max-w-[440px] w-full bg-[#0A0A0A] border border-white/10 rounded-[3.5rem] p-10 space-y-8 shadow-[0_40px_100px_rgba(0,0,0,1)] relative overflow-hidden ring-1 ring-white/5">
              <button onClick={() => setShowShareModal(false)} className="absolute top-8 right-8 text-slate-600 hover:text-white transition-colors"><X size={32} /></button>
              <div className="text-center space-y-3 pt-4">
                 <h3 className="text-3xl font-black text-white uppercase tracking-tighter uppercase leading-none">Expand Mesh</h3>
                 <p className="text-xs font-bold text-slate-500 uppercase tracking-widest tracking-tight italic opacity-60">Handshake protocol required for link</p>
              </div>
              <div className="p-8 bg-white rounded-[3rem] aspect-square flex items-center justify-center shadow-2xl shadow-cyan-500/20"><img src={qrUrl} alt="QR" className="w-full h-full" /></div>
              <div className="grid grid-cols-2 gap-5">
                 <button onClick={() => robustCopy(joinUrl, 'link')} className={`flex-col items-center gap-3 p-6 border border-white/5 rounded-[2rem] transition-all relative overflow-hidden ${copyFeedback === 'link' ? 'bg-green-600 text-white shadow-green-600/30' : 'bg-white/5 hover:bg-white/10 group'}`}>{copyFeedback === 'link' ? <Check size={28} /> : <LinkIcon size={28} className="text-cyan-500 group-hover:scale-110 transition-all" />}<span className="text-[11px] font-black uppercase tracking-widest leading-none">{copyFeedback === 'link' ? 'COPIED' : 'COPY LINK'}</span></button>
                 <button onClick={() => robustCopy(`ID: ${roomId}\nKey: ${passkey}`, 'info')} className={`flex-1 flex flex-col items-center gap-3 p-6 border border-white/5 rounded-[2rem] transition-all relative overflow-hidden ${copyFeedback === 'info' ? 'bg-green-600 text-white shadow-green-600/30' : 'bg-white/5 hover:bg-white/10 group'}`}>{copyFeedback === 'info' ? <Check size={28} /> : <Copy size={28} className="text-cyan-500 group-hover:scale-110 transition-all" />}<span className="text-[11px] font-black uppercase tracking-widest leading-none">{copyFeedback === 'info' ? 'COPIED' : 'COPY INFO'}</span></button>
              </div>
           </div>
        </div>
      )}

      {/* PROGRESS OVERLAY */}
      {isTransferring && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 w-[90%] max-w-[400px] bg-[#0A0A0A] border border-white/10 rounded-[3rem] p-8 shadow-[0_30px_100px_rgba(0,0,0,0.8)] z-[700] animate-in slide-in-from-bottom-8 space-y-6 ring-2 ring-cyan-500/20 backdrop-blur-3xl">
           <div className="flex justify-between items-center px-2">
              <div className="flex items-center gap-4">
                 <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20 shadow-inner">
                    <Loader2 size={28} className={`text-cyan-500 animate-spin`} />
                 </div>
                 <div className="flex flex-col overflow-hidden max-w-[150px]">
                    <span className="text-sm font-black text-white uppercase truncate tracking-tight">{activeFileName}</span>
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">ROUTING BLOB DATA</span>
                 </div>
              </div>
              <div className="text-3xl font-black text-white tracking-tighter">{transferProgress}%</div>
           </div>
           <div className="h-2 bg-white/5 rounded-full overflow-hidden shadow-inner"><div className="h-full bg-cyan-500 shadow-[0_0_15px_#06b6d4] transition-all duration-500 ease-out" style={{ width: `${transferProgress}%` }}></div></div>
        </div>
      )}
    </div>
  );
};

export default App;
