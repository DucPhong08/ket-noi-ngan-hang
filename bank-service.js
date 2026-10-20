const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4002;

// In-memory data
const stats = {
  connections: 0,
  requests: 0,
  charges: 0,
  duplicates: 0
};

// Lưu trữ các giao dịch theo Idempotency-Key và Reference
const idempotencyStore = new Map(); // key -> { status, data }
const chargedReferences = new Set(); // reference đã từng được trừ tiền

// Middleware đếm requests
app.use((req, res, next) => {
  if (req.path === '/charges') {
    stats.requests++;
  }
  next();
});

// GET /stats
app.get('/stats', (req, res) => {
  res.json({
    connections: stats.connections,
    requests: stats.requests,
    charges: stats.charges,
    duplicates: stats.duplicates
  });
});

// POST /reset (hỗ trợ kiểm thử giữa các kịch bản)
app.post('/reset', (req, res) => {
  stats.requests = 0;
  stats.charges = 0;
  stats.duplicates = 0;
  stats.connections = 0;
  idempotencyStore.clear();
  chargedReferences.clear();
  res.json({ message: 'Stats and store reset successfully', stats });
});

// POST /charges
app.post('/charges', async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];
  const { reference, amount } = req.body;

  // 1. Kiểm tra Idempotency-Key: Nếu đã có, trả lại kết quả cũ ngay, không trừ thêm
  if (idempotencyKey && idempotencyStore.has(idempotencyKey)) {
    const cached = idempotencyStore.get(idempotencyKey);
    // Vẫn áp dụng delay nếu có
    const delayMs = parseInt(process.env.DELAY_MS || '0', 10);
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    return res.status(cached.status).json(cached.data);
  }

  // 2. Kiểm tra tính hợp lệ của số tiền
  if (amount === undefined || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Số tiền không hợp lệ' });
  }

  // 3. Kiểm tra hạn mức 20.000.000đ
  if (amount > 20000000) {
    const errData = { error: 'Vượt hạn mức 20.000.000đ' };
    if (idempotencyKey) {
      idempotencyStore.set(idempotencyKey, { status: 402, data: errData });
    }
    return res.status(402).json(errData);
  }

  // 4. Giả lập FAIL_RATE: lỗi 500 trước khi trừ tiền
  const failRate = parseFloat(process.env.FAIL_RATE || '0');
  if (failRate > 0 && Math.random() < failRate) {
    return res.status(500).json({ error: 'Lỗi hệ thống ngân hàng (simulated 500)' });
  }

  // 5. Giả lập độ trễ DELAY_MS
  const delayMs = parseInt(process.env.DELAY_MS || '0', 10);
  if (delayMs > 0) {
    await new Promise(r => setTimeout(r, delayMs));
  }

  // 6. Thực hiện trừ tiền
  const chargeId = `C${stats.charges + 1}`;
  stats.charges++;

  // Kiểm tra trừ tiền trùng lặp cho cùng một reference
  if (reference) {
    if (chargedReferences.has(reference)) {
      stats.duplicates++;
      console.warn(`[BANK WARNING] Phát hiện trừ tiền trùng cho reference: ${reference}! Duplicates: ${stats.duplicates}`);
    } else {
      chargedReferences.add(reference);
    }
  }

  const successData = {
    chargeId,
    reference,
    amount,
    status: 'PAID'
  };

  // Lưu lại kết quả theo idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { status: 201, data: successData });
  }

  // 7. Giả lập DROP_RATE: trừ tiền xong rồi cắt kết nối trước khi trả lời
  const dropRate = parseFloat(process.env.DROP_RATE || '0');
  if (dropRate > 0 && Math.random() < dropRate) {
    console.log(`[BANK DROP] Trừ tiền thành công chargeId=${chargeId} nhưng cắt kết nối TCP (DROP_RATE=${dropRate})`);
    // Ngắt kết nối socket lập tức
    req.socket.destroy();
    return;
  }

  return res.status(201).json(successData);
});

const server = app.listen(PORT, () => {
  console.log(`[BANK SERVICE] Đang chạy tại cổng ${PORT}`);
  console.log(`[BANK CONFIG] DELAY_MS=${process.env.DELAY_MS || 0}, FAIL_RATE=${process.env.FAIL_RATE || 0}, DROP_RATE=${process.env.DROP_RATE || 0}`);
});

// Ngân hàng giữ kết nối nhàn rỗi tối đa 5 giây (mặc định của Node.js)
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;

// In log mỗi khi có kết nối TCP mới và tăng stats.connections
server.on('connection', (socket) => {
  stats.connections++;
  // console.log(`[BANK TCP] Kết nối mới nhận (Tổng connections: ${stats.connections})`);
});
