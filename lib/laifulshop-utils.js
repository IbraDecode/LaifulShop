import fs from 'fs'
import fetch from 'node-fetch'

const defaultThumb = global.urlfoto || 'https://atlantich2h.com/favicon.ico'

function buildButtons(quickButtons = []) {
  return quickButtons.map(btn => ({
    buttonId: btn.id,
    buttonText: { displayText: btn.text },
    type: 1
  }))
}

export async function sendNativeMenu(sock, jid, caption, quickButtons = [], sections = [], title = 'MENU') {
  const buttons = [...buildButtons(quickButtons)]
  buttons.push({
    buttonId: 'action',
    buttonText: { displayText: title },
    type: 4,
    nativeFlowInfo: {
      name: 'single_select',
      paramsJson: JSON.stringify({
        title,
        sections
      })
    }
  })

  return sock.sendMessage(jid, {
    buttons,
    headerType: 1,
    viewOnce: true,
    document: fs.readFileSync('./package.json'),
    fileName: 'BY LaifulShop',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileLength: 999999999999999999n,
    caption,
    contextInfo: {
      isForwarded: true,
      mentionedJid: [jid],
      externalAdReply: {
        title: '©LaifulShop',
        body: 'Laiful Shop',
        thumbnailUrl: defaultThumb,
        sourceUrl: 'https://atlantich2h.com',
        mediaType: 1,
        renderLargerThumbnail: true
      }
    }
  })
}

export async function sendButtons(sock, jid, caption, quickButtons = []) {
  const buttons = buildButtons(quickButtons)
  return sock.sendMessage(jid, {
    buttons,
    headerType: 1,
    viewOnce: true,
    document: fs.readFileSync('./package.json'),
    fileName: 'BY LaifulShop',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileLength: 999999999999999999n,
    caption,
    contextInfo: {
      isForwarded: true,
      mentionedJid: [jid],
      externalAdReply: {
        title: '©LaifulShop',
        body: 'Laiful Shop',
        thumbnailUrl: defaultThumb,
        sourceUrl: 'https://atlantich2h.com',
        mediaType: 1,
        renderLargerThumbnail: true
      }
    }
  })
}

export async function sendImageUrl(sock, jid, imgUrl, caption) {
  try {
    const res = await fetch(imgUrl)
    const buffer = await res.arrayBuffer()
    return sock.sendMessage(jid, { image: Buffer.from(buffer), caption })
  } catch (e) {
    return sock.sendMessage(jid, { text: caption })
  }
}

export function encodeId(text) {
  return encodeURIComponent(text || '')
}

export function decodeId(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
