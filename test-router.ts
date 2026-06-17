import { Hono } from 'hono'
import { reelRouter } from './src/routes/reelRoutes.ts'

const app = new Hono()
app.route('/api/v1/reels', reelRouter)

const req = new Request('http://localhost:3000/api/v1/reels/feed/personalized/69cc28e57bf9957c357c4150?limit=20')
const res = await app.fetch(req)
console.log('Status:', res.status)
