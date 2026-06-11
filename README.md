# School Management System (MCP Architecture)

A portfolio-grade, secure, local-first School Management System utilizing a Model Context Protocol (MCP) Client/Server architecture, role-based access control (ReBAC), and a local Ollama LLM.

---

## 🏛️ Architecture Overview

The system is built on a 3-tier decoupled architecture and implements **both the MCP Client and MCP Server** locally:

1. **Frontend (Vite + React)**: A premium, dark slate-blue glassmorphic user interface. It manages separate dashboard views and AI chats for Admins, Teachers, and Students, automatically injecting dropdown-selected active class context into the AI session.
2. **Express API Gateway (MCP Client)**: Implements the **MCP Client** in `server/src/services/mcp.service.ts`. It spawns the MCP Server subprocess, connects via stdio, fetches tool schemas, and manages the agentic chat loop using a local Ollama model to call database tools dynamically.
3. **TypeScript MCP Server (MCP Server)**: Implements the **MCP Server** in `server/src/server.ts`. Running over stdio transport, it registers all available database/statistical tools and runs a 3-layer security pipeline (ReBAC, Query Firewall, and Production Sanitation) to validate and execute database actions on MongoDB.
4. **MongoDB Databases**: Multi-environment databases run inside Docker containers on port `27117` (Staging) and `27118` (Production).

---

## 🚀 Setup & Installation Steps

### Step 1: Spin up Databases (Docker)
Ensure Docker is running, then spin up the Staging and Production MongoDB containers from the root directory:
```powershell
docker compose up -d
```

### Step 2: Install Dependencies
Install packages for both the backend/MCP server and the client:
```powershell
# Install root/server dependencies
npm install

# Install client dependencies
cd client
npm install
cd ..
```

### Step 3: Seed the Database
Seed the staging database with initial mock users (Admin, Teachers, Students), classes, and marks:
```powershell
# Compile the typescript scripts first
npm run build:server

# Run seeder
npm run seed
```

### Step 4: Run Programmatic Security Tests
Run the integration verification suite to check that ReBAC boundaries, firewalls, and numeric mark statistics function correctly:
```powershell
npm run verify
```
*(All 20 security assertions must pass successfully!)*

### Step 5: Start the API Gateway
Launch the Gateway server on port `3000`:
```powershell
npm run start:gateway
```

### Step 6: Launch the Web UI
Open a new terminal window, navigate to the client, and start the Vite dev server:
```powershell
cd client
npm run dev
```
Open `http://localhost:5173` in your browser.

---

## 🧠 Model Evolution, Latency & GPU Offloading

We initially developed the chat assistant using Ollama's **`qwen2.5:1.5b`** model, but hit severe reasoning limits:
* **The Issues (1.5B)**: Context overwhelm, outputting conversational preambles that broke the JSON tool parser, parameter guessing (hallucinating student IDs), and making up fictional student rosters.
* **The Solutions (1.5B)**: Had to implement keyword-based tool intent routing, inject extensive few-shot prompt examples, and code JSON bleed-through recovery loops.

### 🚀 Upgrading to Llama 3 8B (`llama3.1:8b`)
To build a more robust agent, we upgraded the backend configuration to **Llama 3 8B**. 
* **The Result**: Excellent tool-use reasoning, native schema parsing, and strong rule compliance.
* **Code Refactoring**: We stripped away the intent-routing hacks, the mock few-shot arrays (saving **1,000+ tokens of context overhead** per request), and the JSON bleed guards. The gateway now runs a clean, minimal orchestrator.

### 🐌 The CPU Latency Challenge
While Llama 3 8B is far more intelligent, running a 8B model locally on a CPU or integrated GPU (like Intel Iris Xe) results in **extremely high response latency** (often taking **30 to 90 seconds** per message exchange).

### ⚡ Recommended Offloading Solution: Google Colab + Ngrok
To get near-instant response speeds (**30+ tokens/second**) without stressing local hardware, you can run the model on a free Google Colab GPU and tunnel it to your gateway using Ngrok:

1. **In Google Colab** (with a GPU runtime):
   * Install Ollama:
     ```bash
     !curl -fsSL https://ollama.com/install.sh | sh
     ```
   * Start the Ollama server in the background:
     ```python
     import os, subprocess, time
     os.environ['OLLAMA_HOST'] = '0.0.0.0'
     subprocess.Popen(["ollama", "serve"])
     time.sleep(3)
     ```
   * Pull Llama 3:
     ```bash
     !ollama pull llama3.1:8b
     ```
   * Expose the port via Ngrok (sign up for a free token at `ngrok.com`):
     ```python
     !pip install pyngrok
     from pyngrok import ngrok
     ngrok.set_auth_token("YOUR_NGROK_AUTHTOKEN")
     tunnel = ngrok.connect(11434, "http")
     print("Public URL:", tunnel.public_url)
     ```
2. **In your local codebase**:
   * Open `environments.yaml` and update the `ollama.endpoint` with your new Ngrok URL (e.g. `https://xxxx.ngrok-free.app`).
   * Restart the gateway server. Your local app will now run with cloud GPU speeds.
