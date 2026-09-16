PNPM := corepack pnpm
BACKEND := src/backend
.PHONY: install dev frontend backend check test build e2e docker
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
