.PHONY: web-install web-dev dev-api build run test test-web

web-install:
	npm --prefix web ci

web-dev:
	npm --prefix web run dev

dev-api:
	go run ./cmd/server

build:
	npm --prefix web run build
	go build -o bin/sillage ./cmd/server

run:
	SILLAGE_WEB_DIR=web/dist ./bin/sillage

test:
	go test ./...
	go vet ./...
	go build ./...
	npm --prefix web run check

test-web: build
	npm --prefix web test
