PNPM := corepack pnpm
BACKEND := src/backend
.PHONY: install dev frontend backend check test build e2e docker db-init test-postgres db-up db-down db-status
install:
	$(PNPM) install
	cd $(BACKEND) && uv sync
frontend:
	$(PNPM) dev
backend:
	cd $(BACKEND) && uv run python -m rabbit_hole
# Run both servers with one command; terminate both on Ctrl-C.
dev:
	@python3 scripts/dev.py
check:
	$(PNPM) typecheck
	cd $(BACKEND) && uv run ruff check .
	$(MAKE) test
	$(MAKE) build
test:
	$(PNPM) test
	cd $(BACKEND) && uv run pytest
build:
	$(PNPM) build
e2e:
	$(PNPM) e2e
docker:
	docker build -t rabbit-hole-backend src/backend

# Run once against DATABASE_URL before starting the app; safe to repeat.
db-init:
	cd $(BACKEND) && uv run python -m rabbit_hole.history

# Explicit, isolated PostgreSQL integration tests (TEST_DATABASE_URL required).
test-postgres:
	cd $(BACKEND) && uv run pytest tests/test_history_postgres.py

# Local persistent PostgreSQL; configuration is read only from backend .env.
db-up:
	docker compose --env-file $(BACKEND)/.env up -d --wait postgres
db-down:
	docker compose --env-file $(BACKEND)/.env down
db-status:
	docker compose --env-file $(BACKEND)/.env ps
