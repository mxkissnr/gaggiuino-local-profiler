package backup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"

	"golang.org/x/crypto/scrypt"
)

// This file ports lib/backup-crypto.js: encrypts the two genuinely
// sensitive fields a full backup can optionally carry (the API token and
// MQTT broker credentials) with a passphrase supplied at export time.
// Everything else in a backup stays plaintext JSON — this is deliberately
// narrow, not whole-file encryption.

const (
	algorithm = "aes-256-gcm-scrypt-v1" // versioned so a future KDF/cipher change can coexist with old blobs
	keyLen    = 32                      // AES-256
	ivLen     = 12                      // GCM-recommended nonce size
	saltLen   = 16
)

// scryptN/scryptR/scryptP mirror lib/backup-crypto.js's SCRYPT_OPTS: N=2^14
// is scrypt's own recommended interactive-use minimum (RFC 7914) — this
// runs synchronously in an HTTP handler goroutine (no worker offload), so
// it's deliberately not raised higher.
const (
	scryptN = 16384
	scryptR = 8
	scryptP = 1
)

// EncryptedSecrets mirrors openapi.yaml's EncryptedSecrets schema — the
// self-contained blob (salt/iv/authTag/ciphertext, all base64) safe to
// embed as a backup's top-level `secrets` field.
type EncryptedSecrets struct {
	Alg        string `json:"alg"`
	Salt       string `json:"salt"`
	IV         string `json:"iv"`
	AuthTag    string `json:"authTag"`
	Ciphertext string `json:"ciphertext"`
}

func deriveKey(passphrase string, salt []byte) ([]byte, error) {
	return scrypt.Key([]byte(passphrase), salt, scryptN, scryptR, scryptP, keyLen)
}

// EncryptSecrets ports encryptSecrets(payload, passphrase): payload is
// marshaled to JSON, then AES-256-GCM encrypted under a scrypt-derived key.
func EncryptSecrets(payload any, passphrase string) (*EncryptedSecrets, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	iv := make([]byte, ivLen)
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	key, err := deriveKey(passphrase, salt)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, ivLen)
	if err != nil {
		return nil, err
	}
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	// Go's GCM Seal appends the auth tag to the ciphertext; Node's
	// createCipheriv keeps them separate (cipher.final() +
	// cipher.getAuthTag()) — split them back apart here so the on-disk/
	// wire shape (separate authTag/ciphertext base64 fields) matches the
	// Node original's byte for byte.
	sealed := gcm.Seal(nil, iv, plaintext, nil)
	ciphertext := sealed[:len(sealed)-gcm.Overhead()]
	authTag := sealed[len(sealed)-gcm.Overhead():]

	return &EncryptedSecrets{
		Alg:        algorithm,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		IV:         base64.StdEncoding.EncodeToString(iv),
		AuthTag:    base64.StdEncoding.EncodeToString(authTag),
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
	}, nil
}

// DecryptSecrets ports decryptSecrets(blob, passphrase): returns the
// decrypted payload (as a generic map, further picked apart by the
// restore handler), or nil for anything that doesn't yield trustworthy
// plaintext — wrong passphrase, a corrupted/hand-edited blob, or an
// unknown algorithm version. GCM's auth-tag check is what actually rejects
// a wrong passphrase; every error path below collapses to a nil return,
// matching the Node original's blanket try/catch.
func DecryptSecrets(blob *EncryptedSecrets, passphrase string) map[string]any {
	if blob == nil || blob.Alg != algorithm || passphrase == "" {
		return nil
	}
	salt, err := base64.StdEncoding.DecodeString(blob.Salt)
	if err != nil {
		return nil
	}
	iv, err := base64.StdEncoding.DecodeString(blob.IV)
	if err != nil || len(iv) != ivLen {
		return nil
	}
	authTag, err := base64.StdEncoding.DecodeString(blob.AuthTag)
	if err != nil || len(authTag) != 16 {
		return nil
	}
	ciphertext, err := base64.StdEncoding.DecodeString(blob.Ciphertext)
	if err != nil {
		return nil
	}
	key, err := deriveKey(passphrase, salt)
	if err != nil {
		return nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, ivLen)
	if err != nil {
		return nil
	}
	sealed := append(append([]byte{}, ciphertext...), authTag...)
	plaintext, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(plaintext, &out); err != nil {
		return nil
	}
	return out
}
