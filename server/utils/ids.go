package utils

import (
	"crypto/rand"
	"fmt"
	"math/big"
)

// GenerateSecretKey creates a high-entropy 32-character hex string
func GenerateSecretKey() string {
	b := make([]byte, 16)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// GenerateHumanFriendlyID creates a readable ID like "swift-gopher-42"
func GenerateHumanFriendlyID() string {
	adjectives := []string{"swift", "brave", "calm", "bright", "cool", "bold", "neon", "solar"}
	nouns := []string{"gopher", "falcon", "panda", "river", "mountain", "star", "bolt", "orbit"}
	
	adjIndex, _ := rand.Int(rand.Reader, big.NewInt(int64(len(adjectives))))
	nounIndex, _ := rand.Int(rand.Reader, big.NewInt(int64(len(nouns))))
	num, _ := rand.Int(rand.Reader, big.NewInt(100))

	return fmt.Sprintf("%s-%s-%d", adjectives[adjIndex.Int64()], nouns[nounIndex.Int64()], num.Int64())
}
