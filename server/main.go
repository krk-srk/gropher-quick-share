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
	maxMessageSize = 1024 * 1024
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Message struct {
	Type    string `json:"type"`
	RoomID  string `json:"roomId"`
	PeerID  string `json:"peerId"`
	Passkey string `json:"passkey,omitempty"`
	Data    string `json:"data,omitempty"`
}

type Client struct {
	Conn   *websocket.Conn
	PeerID string
	mu     sync.Mutex
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

// Health check for AWS Load Balancers
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "OK")
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

	stopPing := make(chan bool)
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(writeWait)); err != nil {
					return
				}
			case <-stopPing:
				return
			}
		}
	}()
	defer close(stopPing)

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
			client := &Client{Conn: conn, PeerID: msg.PeerID}

			if room, exists := rooms[currentRoom]; !exists {
				rooms[currentRoom] = &Room{
					Passkey: msg.Passkey,
					Clients: map[string]*Client{currentPeerID: client},
				}
				log.Printf("[Room Created] %s", currentRoom)
				client.SafeWrite(Message{Type: "join-success"})
			} else {
				if room.Passkey != msg.Passkey {
					client.SafeWrite(Message{Type: "error", Data: "Invalid Passkey"})
					roomsMu.Unlock()
					return
				}
				
				room.Clients[currentPeerID] = client
				client.SafeWrite(Message{Type: "join-success"})
				
				for pid, c := range room.Clients {
					if pid != currentPeerID {
						c.SafeWrite(Message{Type: "peer-joined", PeerID: currentPeerID})
						client.SafeWrite(Message{Type: "peer-joined", PeerID: pid})
					}
				}
			}
		case "offer", "answer", "candidate":
			if room, ok := rooms[currentRoom]; ok {
				for pid, client := range room.Clients {
					if pid != msg.PeerID {
						client.SafeWrite(msg)
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
			go func(rid string) {
				time.Sleep(3 * time.Second)
				roomsMu.Lock()
				if r, ex := rooms[rid]; ex && len(r.Clients) == 0 {
					delete(rooms, rid)
					log.Printf("[Room Deleted] %s", rid)
				}
				roomsMu.Unlock()
			}(currentRoom)
		}
	}
	roomsMu.Unlock()
}

func main() {
	http.HandleFunc("/ws", handleConnections)
	http.HandleFunc("/health", handleHealth)
	fmt.Println("🚀 GopherDrop signaling active on :8080")
	log.Fatal(http.ListenAndServe("0.0.0.0:8080", nil))
}
