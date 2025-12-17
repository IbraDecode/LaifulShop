import atlanticClient from '../lib/atlanticClient.js'
import { sendNativeMenu, sendButtons, sendImageUrl, encodeId, decodeId } from '../lib/laifulshop-utils.js'

const SESSION_TTL = 30 * 60 * 1000
const RATE_LIMIT_MS = 1500
const priceCache = new Map()
const sessions = new Map()
const rateMap = new Map()
let cachedDepositMethods = []

function parseCommand(text = '') {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  const prefix = /^[.!#/\\]/.test(lower) ? lower[0] : ''
  const command = prefix ? lower.slice(1) : lower
  return { command, lower: lower, raw: trimmed }
}

function getSession(jid) {
  const now = Date.now()
  let session = sessions.get(jid)
  if (!session || now - session.lastActive > SESSION_TTL) {
    session = {
      state: 'IDLE',
      ctx: {},
      lastActive: now,
      lastTrxId: null,
      lastTrxType: null,
      lastDepositId: null,
      lastTransferId: null
    }
    sessions.set(jid, session)
  }
  session.lastActive = now
  return session
}

function resetState(session) {
  session.state = 'IDLE'
  session.ctx = {}
}

function checkRateLimit(jid) {
  const now = Date.now()
  const last = rateMap.get(jid) || 0
  const diff = now - last
  if (diff < RATE_LIMIT_MS) {
    return RATE_LIMIT_MS - diff
  }
  rateMap.set(jid, now)
  return 0
}

async function getPriceList(type) {
  const cached = priceCache.get(type)
  const now = Date.now()
  if (cached && now - cached.fetchedAt < 5 * 60 * 1000) {
    return cached.data
  }
  const res = await atlanticClient.post('/layanan/price_list', { type })
  const list = res?.data || res?.result || []
  priceCache.set(type, { data: list, fetchedAt: now })
  return list
}

function groupCategories(list = []) {
  const map = {}
  for (const item of list) {
    const cat = item.kategori || item.category || item.type || 'LAINNYA'
    if (!map[cat]) map[cat] = []
    map[cat].push(item)
  }
  return map
}

function pickProduct(list = [], code) {
  const lower = String(code).toLowerCase()
  return list.find(item => String(item.code || item.kode || '').toLowerCase() === lower)
}

function formatPrice(val) {
  const num = Number(val) || 0
  return num.toLocaleString('id-ID')
}

function buildProductCaption(product) {
  return [
    `*${product?.product_name || product?.nama || product?.name || product?.code}*`,
    `Kode: ${product?.code || product?.kode || '-'}`,
    `Harga: Rp${formatPrice(product?.price || product?.harga || 0)}`,
    product?.desc ? `Deskripsi: ${product.desc}` : null,
    product?.note ? `Catatan: ${product.note}` : null
  ].filter(Boolean).join('\n')
}

async function sendMainMenu(conn, jid) {
  const caption = `*LAIFULSHOP*\nPilih layanan transaksi Atlantic H2H:`
  const sections = [
    {
      title: 'MENU UTAMA',
      highlight_label: 'Recommended',
      rows: [
        { title: 'PRABAYAR', id: '.ls_prabayar' },
        { title: 'PASCABAYAR', id: '.ls_pascabayar' },
        { title: 'DEPOSIT', id: '.ls_deposit' },
        { title: 'TRANSFER', id: '.ls_transfer' },
        { title: 'PROFILE', id: '.ls_profile' },
        { title: 'HELP', id: '.ls_help' }
      ]
    }
  ]
  const quick = [
    { id: '.ls_profile', text: 'SALDO' },
    { id: '.ls_help', text: 'HELP' }
  ]
  await sendNativeMenu(conn, jid, caption, quick, sections, 'LIST FITUR')
}

async function sendStatus(conn, jid, title, payload, quick = []) {
  const caption = [title, '', payload].filter(Boolean).join('\n')
  await sendButtons(conn, jid, caption, quick)
}

async function handlePrabayar(conn, m, session, command) {
  if (command === 'ls_prabayar') {
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const list = await getPriceList('prabayar')
    const grouped = groupCategories(list)
    const rows = Object.keys(grouped).slice(0, 30).map(cat => ({
      title: cat,
      id: `.ls_pb_cat_${encodeId(cat)}`
    }))
    const sections = [{ title: 'Kategori Prabayar', highlight_label: 'Pilih', rows }]
    const caption = '*Prabayar*\nPilih kategori produk'
    await sendNativeMenu(conn, m.chat, caption, [
      { id: '.ls_menu', text: 'MENU' }
    ], sections, 'PILIH KATEGORI')
    resetState(session)
    session.state = 'PB_PICK_CAT'
    return true
  }

  if (command.startsWith('ls_pb_cat_')) {
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const category = decodeId(command.replace('ls_pb_cat_', ''))
    const list = await getPriceList('prabayar')
    const grouped = groupCategories(list)
    const products = grouped[category] || []
    if (!products.length) return conn.sendMessage(m.chat, { text: 'Kategori tidak ditemukan.' }, { quoted: m })
    const rows = products.slice(0, 30).map(item => ({
      title: `${item.product_name || item.nama || item.code} - Rp${formatPrice(item.price || item.harga || 0)}`,
      id: `.ls_pb_item_${item.code || item.kode}`
    }))
    const sections = [{ title: `Produk ${category}`, rows }]
    await sendNativeMenu(conn, m.chat, `Pilih produk untuk ${category}`, [
      { id: '.ls_prabayar', text: 'KEMBALI' },
      { id: '.ls_menu', text: 'MENU' }
    ], sections, 'PILIH PRODUK')
    resetState(session)
    session.state = 'PB_PICK_ITEM'
    return true
  }

  if (command.startsWith('ls_pb_item_')) {
    const code = command.replace('ls_pb_item_', '')
    const list = await getPriceList('prabayar')
    const product = pickProduct(list, code)
    if (!product) return conn.sendMessage(m.chat, { text: 'Produk tidak ditemukan.' }, { quoted: m })
    const caption = buildProductCaption(product)
    session.ctx.product = product
    await sendButtons(conn, m.chat, caption, [
      { id: `.ls_pb_buy_${product.code || product.kode}`, text: 'BELI' },
      { id: '.ls_prabayar', text: 'KEMBALI' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    if (product.img_url) {
      await sendImageUrl(conn, m.chat, product.img_url, caption)
    }
    resetState(session)
    session.state = 'PB_WAIT_TARGET'
    return true
  }

  if (command.startsWith('ls_pb_buy_')) {
    const code = command.replace('ls_pb_buy_', '')
    const list = await getPriceList('prabayar')
    const product = pickProduct(list, code)
    if (!product) return conn.sendMessage(m.chat, { text: 'Produk tidak ditemukan.' }, { quoted: m })
    session.ctx.product = product
    session.state = 'PB_WAIT_TARGET'
    await conn.sendMessage(m.chat, { text: 'Masukkan nomor tujuan/ID pelanggan.' }, { quoted: m })
    return true
  }

  return false
}

async function handlePasca(conn, m, session, command) {
  if (command === 'ls_pascabayar') {
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const list = await getPriceList('pascabayar')
    const rows = list.slice(0, 30).map(item => ({
      title: `${item.product_name || item.nama || item.code}`,
      id: `.ls_pc_item_${item.code || item.kode}`
    }))
    const sections = [{ title: 'Layanan Pascabayar', rows }]
    await sendNativeMenu(conn, m.chat, '*Pascabayar*\nPilih layanan.', [
      { id: '.ls_menu', text: 'MENU' }
    ], sections, 'PILIH LAYANAN')
    resetState(session)
    session.state = 'PASCA_PICK_ITEM'
    return true
  }

  if (command.startsWith('ls_pc_item_')) {
    const code = command.replace('ls_pc_item_', '')
    const list = await getPriceList('pascabayar')
    const product = pickProduct(list, code)
    if (!product) return conn.sendMessage(m.chat, { text: 'Produk tidak ditemukan.' }, { quoted: m })
    session.ctx.product = product
    session.state = 'PASCA_WAIT_CUSTOMER_NO'
    await conn.sendMessage(m.chat, { text: `${buildProductCaption(product)}\n\nMasukkan customer number.` }, { quoted: m })
    return true
  }

  if (command === 'ls_pc_pay') {
    const ctx = session.ctx || {}
    if (!ctx.pendingTagihan) return conn.sendMessage(m.chat, { text: 'Tagihan belum tersedia.' }, { quoted: m })
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const payload = {
      code: ctx.product?.code || ctx.product?.kode,
      reff_id: ctx.reff_id,
      customer_no: ctx.customer_no
    }
    const res = await atlanticClient.post('/transaksi/tagihan/bayar', payload)
    const data = res?.data || res
    session.lastTrxId = data?.id || data?.trxid || data?.transaction_id || ctx.reff_id
    session.lastTrxType = 'pascabayar'
    resetState(session)
    const caption = `Pembayaran diproses.\nID: ${session.lastTrxId}\nStatus: ${data?.status || res?.message || 'diproses'}\nSN: ${data?.sn || '-'}\nTotal: Rp${formatPrice(data?.price || data?.amount || ctx.pendingTagihan?.price)}`
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_trx_status_last', text: 'CEK STATUS' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }
  return false
}

async function handleDeposit(conn, m, session, command) {
  if (command === 'ls_deposit') {
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const res = await atlanticClient.post('/deposit/metode', {})
    const methods = res?.data || res?.result || []
    cachedDepositMethods = methods
    const rows = methods.slice(0, 30).map(item => ({
      title: `${item.metode || item.method} (${item.type || item.tipe || '-'})`,
      id: `.ls_dep_method_${item.metode || item.method}`
    }))
    const sections = [{ title: 'Metode Deposit', rows }]
    await sendNativeMenu(conn, m.chat, 'Pilih metode deposit.', [
      { id: '.ls_menu', text: 'MENU' }
    ], sections, 'METODE DEPOSIT')
    resetState(session)
    session.state = 'DEP_PICK_METHOD'
    return true
  }

  if (command.startsWith('ls_dep_method_')) {
    const method = command.replace('ls_dep_method_', '')
    const found = (cachedDepositMethods || []).find(m => String(m.metode || m.method).toLowerCase() === method.toLowerCase())
    session.ctx.method = found || { metode: method }
    session.state = 'DEP_WAIT_NOMINAL'
    await conn.sendMessage(m.chat, { text: `Masukkan nominal deposit untuk ${method}` }, { quoted: m })
    return true
  }

  if (command === 'ls_dep_status_last') {
    if (!session.lastDepositId) return conn.sendMessage(m.chat, { text: 'Belum ada deposit yang bisa dicek.' }, { quoted: m })
    const res = await atlanticClient.post('/deposit/status', { id: session.lastDepositId })
    const data = res?.data || res
    const caption = `Status Deposit\nID: ${session.lastDepositId}\nStatus: ${data?.status || res?.message || 'unknown'}\nNominal: Rp${formatPrice(data?.nominal || data?.amount || 0)}`
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  if (command === 'ls_dep_cancel_last') {
    if (!session.lastDepositId) return conn.sendMessage(m.chat, { text: 'Tidak ada deposit aktif.' }, { quoted: m })
    const res = await atlanticClient.post('/deposit/cancel', { id: session.lastDepositId })
    const caption = `Deposit dibatalkan.\nID: ${session.lastDepositId}\nStatus: ${res?.message || res?.status || 'cancelled'}`
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  if (command === 'ls_dep_instant') {
    if (!session.lastDepositId) return conn.sendMessage(m.chat, { text: 'Tidak ada deposit untuk instant.' }, { quoted: m })
    const info = await atlanticClient.post('/deposit/instant', { id: session.lastDepositId, action: false })
    session.state = 'DEP_INSTANT_PICK'
    const note = info?.message || 'Konfirmasi untuk memproses instant deposit.'
    await sendButtons(conn, m.chat, note, [
      { id: '.ls_dep_instant_yes', text: 'PROSES INSTANT' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  if (command === 'ls_dep_instant_yes') {
    if (!session.lastDepositId) return conn.sendMessage(m.chat, { text: 'Tidak ada deposit untuk instant.' }, { quoted: m })
    const res = await atlanticClient.post('/deposit/instant', { id: session.lastDepositId, action: true })
    const data = res?.data || res
    resetState(session)
    await sendButtons(conn, m.chat, `Instant diproses.\nStatus: ${data?.status || res?.message || 'diproses'}`, [
      { id: '.ls_dep_status_last', text: 'CEK STATUS' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  return false
}

async function handleTransfer(conn, m, session, command) {
  if (command === 'ls_transfer') {
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const res = await atlanticClient.post('/transfer/bank_list', {})
    const banks = res?.data || res?.result || []
    const rows = banks.slice(0, 30).map(item => ({
      title: `${item.bank_name || item.name} (${item.bank_code || item.code})`,
      id: `.ls_trf_bank_${item.bank_code || item.code}`
    }))
    const sections = [{ title: 'Pilih Bank/E-Wallet', rows }]
    await sendNativeMenu(conn, m.chat, 'Pilih tujuan transfer.', [
      { id: '.ls_menu', text: 'MENU' }
    ], sections, 'DAFTAR BANK')
    resetState(session)
    session.state = 'TRF_PICK_BANK'
    session.ctx.banks = banks
    return true
  }

  if (command.startsWith('ls_trf_bank_')) {
    const code = command.replace('ls_trf_bank_', '')
    const banks = session.ctx.banks || []
    const bank = banks.find(b => String(b.bank_code || b.code).toLowerCase() === code.toLowerCase()) || { bank_code: code }
    session.ctx.bank = bank
    session.state = 'TRF_WAIT_ACCOUNT'
    await conn.sendMessage(m.chat, { text: `Masukkan nomor akun untuk ${bank.bank_name || bank.name || code}.` }, { quoted: m })
    return true
  }

  if (command === 'ls_trf_go') {
    if (!session.ctx.account_number) return conn.sendMessage(m.chat, { text: 'Nomor rekening belum dicek.' }, { quoted: m })
    session.state = 'TRF_WAIT_NOMINAL'
    await conn.sendMessage(m.chat, { text: 'Masukkan nominal transfer.' }, { quoted: m })
    return true
  }

  if (command === 'ls_trf_status_last') {
    if (!session.lastTransferId) return conn.sendMessage(m.chat, { text: 'Belum ada transfer yang bisa dicek.' }, { quoted: m })
    const res = await atlanticClient.post('/transfer/status', { id: session.lastTransferId })
    const data = res?.data || res
    const caption = `Status Transfer\nID: ${session.lastTransferId}\nStatus: ${data?.status || res?.message || 'unknown'}\nNominal: Rp${formatPrice(data?.nominal || data?.amount || 0)}`
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  return false
}

async function handleStatusLast(conn, m, session, command) {
  if (command === 'ls_trx_status_last') {
    if (!session.lastTrxId) return conn.sendMessage(m.chat, { text: 'Belum ada transaksi terakhir.' }, { quoted: m })
    const res = await atlanticClient.post('/transaksi/status', { id: session.lastTrxId, type: session.lastTrxType })
    const data = res?.data || res
    const caption = `Status Transaksi\nID: ${session.lastTrxId}\nStatus: ${data?.status || res?.message || 'unknown'}\nHarga: Rp${formatPrice(data?.price || data?.amount || 0)}`
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }
  return false
}

async function handleProfile(conn, m, command) {
  if (command === 'ls_profile') {
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const res = await atlanticClient.post('/get_profile', {})
    const data = res?.data || res
    const caption = `*Profile*\nNama: ${data?.name || '-'}\nSaldo: Rp${formatPrice(data?.balance || data?.saldo || 0)}\nEmail: ${data?.email || '-'}\nID: ${data?.id || '-'}\nStatus: ${data?.status || res?.message || '-'}`
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }
  return false
}

async function handleHelp(conn, m, command) {
  if (command === 'ls_help') {
    const caption = '*LaifulShop Help*\nGunakan menu interaktif untuk memilih layanan.\n- menu/start: buka menu utama.\n- Ikuti setiap langkah input yang diminta (nomor pelanggan, nominal, catatan).\n- Gunakan tombol CEK STATUS setelah transaksi.'
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }
  return false
}

async function processState(conn, m, session, body) {
  if (session.state === 'PB_WAIT_TARGET') {
    session.ctx.target = body
    session.state = 'PB_WAIT_LIMIT'
    await sendButtons(conn, m.chat, 'Masukkan limit harga (angka) atau klik skip.', [
      { id: '.ls_pb_skip_limit', text: 'SKIP LIMIT' }
    ])
    return true
  }

  if (session.state === 'PB_WAIT_LIMIT') {
    if (body === '.ls_pb_skip_limit') {
      session.ctx.limit_price = null
    } else {
      const limit = Number(body.replace(/[^0-9]/g, ''))
      if (isNaN(limit) || limit <= 0) {
        await conn.sendMessage(m.chat, { text: 'Masukkan angka limit yang valid atau tekan skip.' }, { quoted: m })
        return true
      }
      session.ctx.limit_price = limit
    }
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const product = session.ctx.product
    const payload = {
      code: product?.code || product?.kode,
      reff_id: `PB-${Date.now()}`,
      target: session.ctx.target
    }
    if (session.ctx.limit_price) payload.limit_price = session.ctx.limit_price
    const res = await atlanticClient.post('/transaksi/create', payload)
    const data = res?.data || res
    session.lastTrxId = data?.id || data?.trxid || data?.transaction_id || payload.reff_id
    session.lastTrxType = 'prabayar'
    const caption = `Transaksi dibuat.\nID: ${session.lastTrxId}\nReff: ${payload.reff_id}\nStatus: ${data?.status || res?.message || 'diproses'}\nHarga: Rp${formatPrice(data?.price || data?.amount || product?.price)}`
    resetState(session)
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_trx_status_last', text: 'CEK STATUS' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  if (session.state === 'PASCA_WAIT_CUSTOMER_NO') {
    session.ctx.customer_no = body
    const wait = checkRateLimit(m.sender)
    if (wait > 0) return conn.sendMessage(m.chat, { text: `Tunggu ${Math.ceil(wait / 100) / 10}s sebelum melanjutkan.` }, { quoted: m })
    const payload = {
      code: session.ctx.product?.code || session.ctx.product?.kode,
      reff_id: `PC-${Date.now()}`,
      customer_no: body
    }
    const res = await atlanticClient.post('/transaksi/tagihan', payload)
    const data = res?.data || res
    session.ctx.pendingTagihan = data
    session.ctx.reff_id = payload.reff_id
    const caption = `Tagihan ditemukan.\nNama: ${data?.customer_name || data?.name || '-'}\nTotal: Rp${formatPrice(data?.price || data?.amount || 0)}\nAdmin: Rp${formatPrice(data?.admin || data?.fee || 0)}\nReff: ${payload.reff_id}`
    session.state = 'PASCA_CONFIRM_PAY'
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_pc_pay', text: 'BAYAR' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  if (session.state === 'DEP_WAIT_NOMINAL') {
    const nominal = Number(body.replace(/[^0-9]/g, ''))
    if (isNaN(nominal) || nominal <= 0) {
      await conn.sendMessage(m.chat, { text: 'Nominal tidak valid.' }, { quoted: m })
      return true
    }
    const method = session.ctx.method || {}
    const payload = {
      reff_id: `DEP-${Date.now()}`,
      nominal,
      type: method.type || method.tipe || method.type_deposit,
      metode: method.metode || method.method || method.metode_deposit
    }
    const res = await atlanticClient.post('/deposit/create', payload)
    const data = res?.data || res
    session.lastDepositId = data?.id || data?.deposit_id || payload.reff_id
    resetState(session)
    const lines = [
      `Deposit dibuat.`,
      `ID: ${session.lastDepositId}`,
      `Reff: ${payload.reff_id}`,
      `Nominal: Rp${formatPrice(nominal)}`,
      data?.fee ? `Fee: Rp${formatPrice(data.fee)}` : null,
      data?.expired ? `Expired: ${data.expired}` : null,
      data?.nomor_va ? `VA: ${data.nomor_va}` : null,
      data?.rekening_tujuan ? `Rekening: ${data.rekening_tujuan}` : null,
      data?.url ? `URL: ${data.url}` : null
    ].filter(Boolean).join('\n')
    await sendButtons(conn, m.chat, lines, [
      { id: '.ls_dep_status_last', text: 'CEK STATUS' },
      { id: '.ls_dep_cancel_last', text: 'CANCEL' },
      { id: '.ls_dep_instant', text: 'INSTANT' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    if (data?.qr_image) {
      await sendImageUrl(conn, m.chat, data.qr_image, 'QR Pembayaran')
    }
    return true
  }

  if (session.state === 'TRF_WAIT_ACCOUNT') {
    const bank = session.ctx.bank
    const payload = {
      bank_code: bank?.bank_code || bank?.code,
      account_number: body
    }
    const res = await atlanticClient.post('/transfer/cek_rekening', payload)
    const data = res?.data || res
    session.ctx.account_number = body
    session.ctx.account_name = data?.account_name || data?.name
    session.state = 'TRF_CONFIRM_NAME'
    const caption = `Rekening dicek.\nNama: ${session.ctx.account_name || '-'}\nStatus: ${data?.status || res?.message || 'OK'}\nLanjut transfer?`
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_trf_go', text: 'LANJUT TRANSFER' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  if (session.state === 'TRF_WAIT_NOMINAL') {
    const nominal = Number(body.replace(/[^0-9]/g, ''))
    if (isNaN(nominal) || nominal <= 0) {
      await conn.sendMessage(m.chat, { text: 'Nominal tidak valid.' }, { quoted: m })
      return true
    }
    session.ctx.nominal = nominal
    session.state = 'TRF_WAIT_NOTE'
    await sendButtons(conn, m.chat, 'Tambahkan catatan? Jika tidak, klik skip.', [
      { id: '.ls_trf_skip_note', text: 'SKIP' }
    ])
    return true
  }

  if (session.state === 'TRF_WAIT_NOTE') {
    const note = body === '.ls_trf_skip_note' ? '' : body
    const payload = {
      ref_id: `TRF-${Date.now()}`,
      kode_bank: session.ctx.bank?.bank_code || session.ctx.bank?.code,
      nomor_akun: session.ctx.account_number,
      nama_pemilik: session.ctx.account_name,
      nominal: session.ctx.nominal,
      note
    }
    const res = await atlanticClient.post('/transfer/create', payload)
    const data = res?.data || res
    session.lastTransferId = data?.id || data?.transfer_id || payload.ref_id
    resetState(session)
    const caption = `Transfer dibuat.\nID: ${session.lastTransferId}\nTotal: Rp${formatPrice(data?.total || data?.amount || payload.nominal)}\nFee: Rp${formatPrice(data?.fee || 0)}\nStatus: ${data?.status || res?.message || 'diproses'}`
    await sendButtons(conn, m.chat, caption, [
      { id: '.ls_trf_status_last', text: 'CEK STATUS' },
      { id: '.ls_menu', text: 'MENU' }
    ])
    return true
  }

  return false
}

async function handler(m) {
  if (!m.text) return
  const { command, lower, raw } = parseCommand(m.text)
  const session = getSession(m.sender)
  const body = raw
  const cmd = command

  if (['menu', 'start', 'ls_menu'].includes(cmd)) {
    resetState(session)
    await sendMainMenu(this, m.chat)
    return
  }

  if (cmd.startsWith('ls_')) {
    if (await handlePrabayar(this, m, session, cmd)) return
    if (await handlePasca(this, m, session, cmd)) return
    if (await handleDeposit(this, m, session, cmd)) return
    if (await handleTransfer(this, m, session, cmd)) return
    if (await handleStatusLast(this, m, session, cmd)) return
    if (await handleProfile(this, m, cmd)) return
    if (await handleHelp(this, m, cmd)) return
  }

  if (lower === 'menu' || lower === 'start') {
    resetState(session)
    await sendMainMenu(this, m.chat)
    return
  }

  if (await processState(this, m, session, body)) return
}

handler.help = ['laifulshop']
handler.tags = ['main']
handler.command = /^ls_.*$/i
handler.all = handler

export default handler
