.DEFAULT_GOAL := help
DOCKER_COMPOSE := docker compose -f deployments/docker/compose.yaml

.PHONY: help web-install web-dev dev-api build run test test-web up down logs

help: ## Affiche les commandes disponibles
	@awk 'BEGIN {FS = ":.*## "; print "Commandes disponibles :"} \
	/^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

web-install: ## Installe les dépendances du frontend
	npm --prefix web ci

web-dev: ## Démarre le serveur de développement Vite
	npm --prefix web run dev

dev-api: ## Démarre le backend Go en mode API seule
	SILLAGE_PUBLIC_URL="$${SILLAGE_PUBLIC_URL-http://127.0.0.1:5173}" go run ./cmd/server

build: ## Compile le frontend et le backend
	npm --prefix web run build
	go build -o bin/sillage ./cmd/server

run: ## Lance le serveur avec le frontend compilé
	SILLAGE_WEB_DIR=web/dist ./bin/sillage

test: ## Exécute les tests Go, vet, build et vérification TypeScript
	go test ./...
	go vet ./...
	go build ./...
	npm --prefix web run check

test-web: build ## Compile l'application et exécute les tests Playwright
	npm --prefix web test

up: ## Construit et démarre les conteneurs Docker
	$(DOCKER_COMPOSE) up -d --build

down: ## Arrête et supprime les conteneurs Docker
	$(DOCKER_COMPOSE) down

logs: ## Affiche les logs Docker en temps réel
	$(DOCKER_COMPOSE) logs -f
