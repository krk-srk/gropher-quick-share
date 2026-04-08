package main

import (
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 4 * 1024 * 1024 // 4MB to handle tunnel overhead
)

var upgrader = websocket.Upgrader{
	// Important for Cloudflare & Local Dev: Allow all origins to prevent CORS blocks 
	// This specifically allows your frontend on http://localhost:5173
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Message struct {
	Type     string      `json:"type"`
	RoomID   string      `json:"roomId"`
	PeerID   string      `json:"peerId"`
	Username string      `json:"username,omitempty"`
	Passkey  string      `json:"passkey,omitempty"`
	Data     interface{} `json:"data,omitempty"`
	TargetID string      `json:"targetId,omitempty"`
}

type Client struct {
	Conn     *websocket.Conn
	PeerID   string
	Username string
	mu       sync.Mutex
}

func (c *Client) SafeWrite(msg interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
	return c.Conn.WriteJSON(msg)
}

type Room struct {
	Passkey string
	Clients map[string]*Client
}

var (
	rooms   = make(map[string]*Room)
	roomsMu sync.Mutex
)

// Health check for Cloudflare and Frontend verification
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "GopherDrop Backend Active")
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	conn.SetReadLimit(maxMessageSize)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	var currentRoom string
	var currentPeerID string

	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			break
		}

		roomsMu.Lock()
		switch msg.Type {
		case "join":
			currentRoom = msg.RoomID
			currentPeerID = msg.PeerID
			client := &Client{Conn: conn, PeerID: msg.PeerID, Username: msg.Username}

			room, exists := rooms[currentRoom]
			if !exists {
				rooms[currentRoom] = &Room{
					Passkey: msg.Passkey,
					Clients: map[string]*Client{currentPeerID: client},
				}
				client.SafeWrite(Message{Type: "join-success"})
			} else {
				if room.Passkey != msg.Passkey {
					client.SafeWrite(Message{Type: "error", Data: "Invalid Passkey"})
				} else {
					room.Clients[currentPeerID] = client
					client.SafeWrite(Message{Type: "join-success"})
					for pid, c := range room.Clients {
						if pid != currentPeerID {
							c.SafeWrite(Message{Type: "peer-joined", PeerID: currentPeerID, Username: msg.Username})
							client.SafeWrite(Message{Type: "peer-joined", PeerID: pid, Username: c.Username})
						}
					}
				}
			}
		case "offer", "answer", "candidate", "request-file", "metadata-update", "chat":
			if room, ok := rooms[currentRoom]; ok {
				if msg.TargetID != "" {
					if target, exists := room.Clients[msg.TargetID]; exists {
						target.SafeWrite(msg)
					}
				} else {
					for pid, client := range room.Clients {
						if pid != msg.PeerID {
							client.SafeWrite(msg)
						}
					}
				}
			}
		}
		roomsMu.Unlock()
	}

	roomsMu.Lock()
	if room, ok := rooms[currentRoom]; ok {
		delete(room.Clients, currentPeerID)
		if len(room.Clients) == 0 {
			delete(rooms, currentRoom)
		} else {
			for _, c := range room.Clients {
				c.SafeWrite(Message{Type: "peer-left", PeerID: currentPeerID})
			}
		}
	}
	roomsMu.Unlock()
}

func main() {
	// Root and Health endpoints
	http.HandleFunc("/", handleHealth)
	http.HandleFunc("/ws", handleConnections)
	
	port := "8080"
	fmt.Println("-----------------------------------------------")
	fmt.Printf("🚀 GopherDrop Pro Mesh Signaling active on :%s\n", port)
	fmt.Println("-----------------------------------------------")
	
	log.Fatal(http.ListenAndServe("0.0.0.0:"+port, nil))
}
