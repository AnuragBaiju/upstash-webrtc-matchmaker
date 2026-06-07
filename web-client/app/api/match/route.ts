import { Redis } from '@upstash/redis'
import { NextResponse } from 'next/server'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

export async function POST(request: Request) {
  const { userId } = await request.json();
  const queueLength = await redis.llen('chat_queue');

  if (queueLength > 0) {
    const partnerId = await redis.rpop('chat_queue');
    if (partnerId) {
      return NextResponse.json({ match: partnerId });
    }
  }

  await redis.lpush('chat_queue', userId);
  await redis.expire('chat_queue', 60);

  return NextResponse.json({ match: null, status: 'waiting' });
}