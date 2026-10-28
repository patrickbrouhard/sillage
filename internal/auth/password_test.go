package auth

import "testing"

func TestPasswordHash(t *testing.T) {
	const password = "phrase secrète avec espaces"
	first, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	second, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !VerifyPassword(first, password) || VerifyPassword(first, password+"!") {
		t.Fatal("invalid password verifier")
	}
	for _, value := range []string{"short", string([]byte{0xff})} {
		if _, err := HashPassword(value); err != ErrPassword {
			t.Fatal(err)
		}
	}
	if VerifyPassword("$argon2id$v=19$m=999999999,t=99,p=1$x$x", password) {
		t.Fatal("unbounded parameters accepted")
	}
}
