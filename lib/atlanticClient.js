import fetch from 'node-fetch'
import { URLSearchParams } from 'url'

const BASE_URL = 'https://atlantich2h.com'
const API_KEY = process.env.ATLANTIC_API_KEY

if (!API_KEY) {
  console.warn('[Atlantic] Missing ATLANTIC_API_KEY env variable. Requests will fail.')
}

async function post(path, payload = {}) {
  const body = new URLSearchParams({ api_key: API_KEY || '', ...payload })
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Atlantic API error ${res.status}: ${text}`)
  }
  const data = await res.json().catch(async () => {
    const fallback = await res.text().catch(() => '')
    throw new Error(`Failed to parse Atlantic response: ${fallback}`)
  })
  return data
}

export default { post }
