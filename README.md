# 🎥 Serverless WebRTC Matchmaker & Video Client

> A production-ready, low-latency serverless WebRTC signaling and matchmaking platform that dynamically pairs users for real-time video and audio communication.

Unlike traditional architectures that rely on dedicated signaling servers, this solution uses a fully serverless approach with **atomic Redis matchmaking** and **Supabase Realtime signaling** — minimising infrastructure costs while maintaining fast connection times.

---

## 🚀 Architecture Overview

The application is split into three independent layers:

| Layer | Technology | Purpose |
|---|---|---|
| Infrastructure | Terraform | Provision and manage cloud resources |
| Matchmaking | Upstash Redis | Atomic FIFO queue pairing |
| Signaling | Supabase Realtime | SDP & ICE exchange over WebSocket |
| Frontend | Next.js + Vercel | Edge-deployed client application |

```
┌─────────────┐         ┌─────────────┐
│   Client A  │         │   Client B  │
└──────┬──────┘         └──────┬──────┘
       │                       │
       ▼                       ▼
┌──────────────────────────────────────┐
│          Upstash Redis               │
│       Matchmaking Queue              │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│         Supabase Realtime            │
│         Signaling Channel            │
│   (SDP Offer / Answer / ICE)         │
└──────────────────────────────────────┘
                   │
                   ▼
        Client A ⟷ WebRTC P2P ⟷ Client B
```

---

## 🛠️ Tech Stack

| Category | Technology |
|---|---|
| Framework | Next.js (App Router) |
| Language | TypeScript |
| Matchmaking Queue | Upstash Redis |
| Signaling | Supabase Realtime |
| Infrastructure | Terraform |
| Deployment | Vercel Edge |
| Communication | WebRTC (P2P) |

---

## 📋 Prerequisites

Before running the project, make sure you have the following installed and configured:

- [Node.js v20+](https://nodejs.org/)
- [Terraform](https://developer.hashicorp.com/terraform/install)
- [Upstash Account](https://upstash.com/)
- [Supabase Account](https://supabase.com/)
- [Vercel Account](https://vercel.com/)

---

## ⚙️ Environment Variables

Create a `.env.local` file inside the `web-client` directory:

```env
# Upstash Redis
UPSTASH_REDIS_REST_URL=https://your-redis-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_rest_token

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

---

## 💻 Local Development

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/webrtc-cloud-resume-project.git
cd webrtc-cloud-resume-project/web-client
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

> **Testing matchmaking locally:** Open the app in two separate browser windows, two different browsers, or one normal window and one incognito window.

---

## 🌐 Production Deployment (Vercel)

### Step 1 — Set the root directory

Since Terraform files live at the repository root, Vercel needs to be pointed at the Next.js app folder.

```
Project Settings → Build & Deployment → Root Directory
```

Set it to `web-client` and choose **Next.js** as the framework preset.

### Step 2 — Add environment variables

```
Project Settings → Environment Variables
```

Add all values from your `.env.local` file.

### Step 3 — Disable deployment protection

To allow public access without requiring a Vercel login:

```
Project Settings → Deployment Protection → Vercel Authentication → OFF
```

### Step 4 — Redeploy

```
Deployments → ⋯ → Redeploy
```

Vercel will rebuild with the updated configuration.

---

## 🔄 Matchmaking Flow

```
1. User clicks Start
       ↓
2. User ID is pushed to the Upstash Redis queue
       ↓
3. Matchmaking API checks for a waiting user
       ↓
4. Two users are atomically paired
       ↓
5. A dedicated Supabase Realtime channel is created
       ↓
6. SDP Offer / Answer exchange begins
       ↓
7. ICE candidates are exchanged
       ↓
8. Direct WebRTC P2P connection is established
       ↓
9. Audio & video stream peer-to-peer 🎥
```

---

## 🔒 Scalability & Security

### Serverless Matchmaking
- No dedicated signaling server to maintain
- No always-on WebSocket infrastructure
- Scales automatically with demand
- Minimal operational cost

### Atomic Redis Operations
- Prevents duplicate matches
- Eliminates race conditions under load
- Maintains strict FIFO pairing order

### Direct Peer Connections
Once signaling completes, **media traffic never touches your backend** — it flows directly browser-to-browser.

---

## 📂 Project Structure

```
webrtc-cloud-resume-project/
│
├── terraform/
│   ├── main.tf
│   ├── variables.tf
│   └── outputs.tf
│
├── web-client/
│   ├── app/
│   ├── components/
│   ├── lib/
│   ├── public/
│   ├── package.json
│   └── next.config.js
│
└── README.md
```

---

## 🛡️ Git Housekeeping

If you accidentally end up with a nested `.git` repo inside `web-client`:

```bash
# Remove the nested git repo
rm -rf web-client/.git

# Clear cached tracking
git rm --cached web-client -f

# Commit and push
git add .
git commit -m "fix: remove nested git repository"
git push origin master
```

---

## 🎯 Key Features

- ⚡ Real-time peer-to-peer video & audio
- 🔀 Serverless atomic matchmaking via Redis
- 📡 Supabase Realtime WebRTC signaling
- 🌍 Global edge deployment via Vercel
- 🏗️ Infrastructure as Code with Terraform
- 📉 Low-latency connection establishment
- ↔️ Horizontally scalable — no bottlenecks

---

## 📜 License

This project is provided for **educational and portfolio purposes**.  
Feel free to fork, modify, and build upon it.
