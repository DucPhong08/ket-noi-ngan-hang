const express = require('express');
const http = require('node:http');
const { URL } = require('node:url');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4001;
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';

// In-memory data
const students = {
  '1': 50000000, // 50.000.000đ
  '2': 0,        // 0đ
  '3': 3200000   // 3.200.000đ
};

// Theo dõi các giao dịch
const payments = new Map();
let paymentCounter = 1;

// HTTP Agent cấu hình Keep-Alive và Connection Pooling
const bankAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 20,       // Tối đa 20 kết nối TCP đồng thời
  maxFreeSockets: 20,
  timeout: 4000         // Socket timeout 4 giây
});

// Helper: Gọi sang Bank Mock với kiểm soát Timeout và Retry thông minh
async function callBankWithRetry({ reference, amount }, maxTotalTimeMs = 4200) {
  const startTime = Date.now();
  const bankParsedUrl = new URL(BANK_URL);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsed = Date.now() - startTime;
    const remainingTime = maxTotalTimeMs - elapsed;

    // Nếu không còn đủ thời gian (dưới 800ms) để thực hiện thêm lần gọi, thoát ngay để đảm bảo tổng thời gian <= 4.5s
    if (attempt > 1 && remainingTime < 800) {
      return {
        status: 504,
        paymentStatus: 'PENDING',
        error: 'Hết thời gian chờ phản hồi từ ngân hàng (Timeout)'
      };
    }

    const currentTimeout = Math.min(4000, Math.max(500, remainingTime));

    try {
      const result = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ reference, amount });
        const req = http.request({
          hostname: bankParsedUrl.hostname,
          port: bankParsedUrl.port || (bankParsedUrl.protocol === 'https:' ? 443 : 80),
          path: '/charges',
          method: 'POST',
          agent: bankAgent,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Idempotency-Key': reference
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch (e) {
              parsed = { raw: data };
            }
            resolve({ statusCode: res.statusCode, data: parsed });
          });
        });

        req.setTimeout(currentTimeout, () => {
          req.destroy(new Error('REQUEST_TIMEOUT'));
        });

        req.on('error', (err) => {
          reject(err);
        });

        req.write(payload);
        req.end();
      });

      // 1. Ngân hàng xác nhận thành công
      if (result.statusCode === 201) {
        return {
          status: 201,
          paymentStatus: 'PAID',
          data: result.data
        };
      }

      // 2. Ngân hàng từ chối rõ ràng (ví dụ 400, 402 vượt hạn mức) -> KHÔNG RETRY
      if (result.statusCode >= 400 && result.statusCode < 500) {
        return {
          status: result.statusCode,
          paymentStatus: 'FAILED',
          error: result.data?.error || 'Ngân hàng từ chối giao dịch'
        };
      }

      // 3. Lỗi 500 từ ngân hàng -> Có thể thử lại nếu còn thời gian
      if (result.statusCode === 500) {
        if (attempt < maxAttempts && (Date.now() - startTime) < (maxTotalTimeMs - 800)) {
          await new Promise(r => setTimeout(r, 100)); // Backoff ngắn
          continue;
        }
        return {
          status: 504,
          paymentStatus: 'PENDING',
          error: 'Ngân hàng gặp sự cố tạm thời (500)'
        };
      }

    } catch (err) {
      // Bắt các lỗi kết nối mạng
      const isConnectionRefused = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND';
      const isTimeout = err.message === 'REQUEST_TIMEOUT' || err.code === 'ETIMEDOUT';
      const isDropped = err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message?.includes('socket hang up');

      // Tình huống 1: Ngân hàng tắt -> Fail Fast, trả ngay 503 trong < 1.5s, không retry
      if (isConnectionRefused) {
        return {
          status: 503,
          paymentStatus: 'FAILED',
          error: 'Không kết nối được tới ngân hàng (Connection refused)'
        };
      }

      // Nếu do Timeout: không đủ thời gian nữa -> trả 504 PENDING
      if (isTimeout) {
        return {
          status: 504,
          paymentStatus: 'PENDING',
          error: 'Hết thời gian chờ phản hồi từ ngân hàng'
        };
      }

      // Nếu bị Drop kết nối (DROP_RATE) hoặc ECONNRESET: thử lại với cùng Idempotency-Key nếu còn thời gian
      if (isDropped) {
        if (attempt < maxAttempts && (Date.now() - startTime) < (maxTotalTimeMs - 800)) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        return {
          status: 504,
          paymentStatus: 'PENDING',
          error: 'Đứt kết nối tới ngân hàng khi đang chờ trả lời'
        };
      }

      // Các lỗi không xác định khác
      return {
        status: 504,
        paymentStatus: 'PENDING',
        error: `Lỗi kết nối: ${err.message}`
      };
    }
  }

  return {
    status: 504,
    paymentStatus: 'PENDING',
    error: 'Quá số lần thử lại tối đa'
  };
}

// GET /students/:id/fees
app.get('/students/:id/fees', (req, res) => {
  const { id } = req.params;
  if (!(id in students)) {
    return res.status(404).json({ error: 'Sinh viên không tồn tại' });
  }
  return res.json({
    studentId: id,
    debt: students[id]
  });
});

// POST /students/:id/payments
app.post('/students/:id/payments', async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;

  // 1. Kiểm tra sinh viên và số tiền hợp lệ
  if (!(id in students)) {
    return res.status(404).json({ error: 'Sinh viên không tồn tại' });
  }

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Số tiền thanh toán không hợp lệ' });
  }

  const currentDebt = students[id];
  if (amount > currentDebt) {
    return res.status(400).json({
      error: `Số tiền thanh toán (${amount.toLocaleString('vi-VN')}đ) vượt quá công nợ hiện tại (${currentDebt.toLocaleString('vi-VN')}đ)`
    });
  }

  // 2. Tạo mã lệnh thanh toán P1, P2...
  const paymentId = `P${paymentCounter++}`;
  const paymentRecord = {
    paymentId,
    studentId: id,
    amount,
    status: 'INITIAL',
    createdAt: new Date().toISOString()
  };
  payments.set(paymentId, paymentRecord);

  // 3. Gọi sang cổng ngân hàng
  const bankResponse = await callBankWithRetry({ reference: paymentId, amount });

  // 4. Cập nhật trạng thái và phản hồi theo quy ước
  paymentRecord.status = bankResponse.paymentStatus;

  if (bankResponse.status === 201) {
    // Chỉ giảm công nợ khi ngân hàng đã xác nhận trừ tiền thành công
    students[id] -= amount;
    paymentRecord.chargeId = bankResponse.data?.chargeId;
    return res.status(201).json({
      paymentId,
      studentId: id,
      amount,
      status: 'PAID',
      chargeId: paymentRecord.chargeId,
      remainingDebt: students[id]
    });
  }

  // Phản hồi lỗi
  return res.status(bankResponse.status).json({
    paymentId,
    status: bankResponse.paymentStatus,
    error: bankResponse.error
  });
});

// GET /payments/:id (hỗ trợ kiểm tra chi tiết trạng thái thanh toán)
app.get('/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) {
    return res.status(404).json({ error: 'Lệnh thanh toán không tồn tại' });
  }
  res.json(payment);
});

// POST /reset (hỗ trợ reset công nợ khi kiểm thử)
app.post('/reset', (req, res) => {
  students['1'] = 50000000;
  students['2'] = 0;
  students['3'] = 3200000;
  paymentCounter = 1;
  payments.clear();
  res.json({ message: 'Fee service reset successfully', students });
});

app.listen(PORT, () => {
  console.log(`[FEE SERVICE] Đang chạy tại cổng ${PORT}`);
  console.log(`[FEE SERVICE] Kết nối tới Bank tại: ${BANK_URL}`);
});
