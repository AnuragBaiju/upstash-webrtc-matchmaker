🎥 Serverless WebRTC Matchmaker & Video Client

A production-ready, low-latency serverless WebRTC signaling and matchmaking platform that dynamically pairs users for real-time video and audio communication.

Unlike traditional architectures that rely on dedicated signaling servers, this solution uses a fully serverless approach with atomic Redis matchmaking and Supabase Realtime signaling, minimizing infrastructure costs while maintaining fast connection times.

⸻

🚀 Architecture Overview

The application is divided into three independent layers:

Infrastructure as Code (IaC)

Infrastructure resources are provisioned and managed using Terraform, ensuring repeatable and consistent deployments.

State Management & Matchmaking

Upstash Redis powers the matchmaking engine using an atomic FIFO queue pattern, allowing users to be paired quickly and reliably.

Signaling Layer

Supabase Realtime is used to exchange:

* SDP Offers
* SDP Answers
* ICE Candidates

between matched peers during WebRTC negotiation.

Frontend Deployment

The client application is built with Next.js (App Router) and deployed globally using Vercel Edge Infrastructure.

⸻

🏗️ System Architecture

┌─────────────┐
│   Client A  │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│   Upstash Redis     │
│ Matchmaking Queue   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Supabase Realtime   │
│  Signaling Channel  │
└─────────┬───────────┘
          │
          ▼
┌─────────────┐
│   Client B  │
└─────────────┘
After signaling completes:
Client A ⟷ WebRTC P2P ⟷ Client B

⸻

🛠️ Tech Stack

Category	Technology
Framework	Next.js (App Router)
Language	TypeScript
State & Queue	Upstash Redis
Signaling	Supabase Realtime
Infrastructure	Terraform
Deployment	Vercel
Communication	WebRTC

⸻

📋 Prerequisites

Before running the project, ensure the following are installed:

* Node.js v20+
* Terraform
* Upstash Account
* Supabase Account
* Vercel Account

⸻

⚙️ Environment Variables

Create a .env.local file inside the web-client directory.

# Upstash Redis
UPSTASH_REDIS_REST_URL=https://your-redis-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_rest_token
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

⸻

💻 Local Development

1. Clone Repository

git clone https://github.com/yourusername/webrtc-cloud-resume-project.git
cd webrtc-cloud-resume-project/web-client

2. Install Dependencies

npm install

3. Start Development Server

npm run dev

Open:

http://localhost:3000

To test matchmaking locally, open the application in:

* Two separate browser windows
* Two different browsers
* One browser and one incognito window

⸻

🌐 Production Deployment (Vercel)

Step 1: Configure Root Directory

Since Terraform files exist at the repository root, Vercel must be pointed to the Next.js application folder.

Navigate to:

Project Settings
→ Build & Deployment
→ Root Directory

Set:

web-client

Framework Preset:

Next.js

Save the changes.

⸻

Step 2: Configure Environment Variables

Navigate to:

Project Settings
→ Environment Variables

Add the values from your local .env.local file.

⸻

Step 3: Disable Deployment Protection

To allow public access without requiring a Vercel account:

Navigate to:

Project Settings
→ Deployment Protection
→ Vercel Authentication

Turn:

OFF

and save.

⸻

Step 4: Redeploy

Navigate to:

Deployments

Select the latest deployment:

⋯ → Redeploy

Vercel will rebuild the application using the updated configuration.

⸻

🔄 Matchmaking Flow

1. User clicks Start
2. User ID is added to the Upstash Redis queue
3. Matchmaking API checks for waiting users
4. Two users are paired atomically
5. Supabase Realtime channel is created
6. SDP Offer/Answer exchange begins
7. ICE candidates are exchanged
8. Direct WebRTC connection is established
9. Audio and video stream peer-to-peer

⸻

🔒 Scalability Benefits

Serverless Matchmaking

* No dedicated signaling server
* No always-on WebSocket infrastructure
* Automatic scaling
* Low operational costs

Atomic Redis Operations

* Prevents duplicate matches
* Eliminates race conditions
* Maintains FIFO pairing

Direct Peer Connections

Once signaling completes:

Browser ⇄ Browser

Media traffic never passes through your backend.

⸻

📂 Project Structure

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

⸻

🛡️ Git Workflow

Remove Accidental Nested Git Repositories

rm -rf web-client/.git

Clear Cached Tracking

git rm --cached web-client -f

Commit Changes

git add .
git commit -m "Deployment optimization"
git push origin master

⸻

🎯 Key Features

* Real-time video chat
* WebRTC peer-to-peer communication
* Serverless matchmaking
* Atomic Redis queue pairing
* Supabase Realtime signaling
* Infrastructure as Code with Terraform
* Edge deployment via Vercel
* Low-latency connection establishment
* Horizontally scalable architecture

⸻

📜 License

This project is provided for educational and portfolio purposes.

Feel free to fork, modify, and build upon it.
