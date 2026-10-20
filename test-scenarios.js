const { spawn } = require('node:child_process');
const http = require('node:http');

const FEE_PORT = 4001;
const BANK_PORT = 4002;
const FEE_URL = `http://localhost:${FEE_PORT}`;
const BANK_URL = `http://localhost:${BANK_PORT}`;

// Helper: HTTP Request
function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const startTime = Date.now();
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const duration = Date.now() - startTime;
        let parsedData;
        try {
          parsedData = JSON.parse(data);
        } catch (e) {
          parsedData = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsedData,
          duration
        });
      });
    });

    req.on('error', (err) => {
      const duration = Date.now() - startTime;
      resolve({
        statusCode: 0,
        error: err,
        duration
      });
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let bankProcess = null;
let feeProcess = null;

function startBank(env = {}) {
  stopBank();
  return new Promise((resolve) => {
    bankProcess = spawn('node', ['bank-service.js'], {
      env: { ...process.env, PORT: BANK_PORT, ...env },
      stdio: 'pipe'
    });
    bankProcess.stdout.on('data', (d) => {
      // console.log(`[BANK OUT] ${d}`);
    });
    setTimeout(resolve, 600); // Đợi server sẵn sàng
  });
}

function stopBank() {
  if (bankProcess) {
    try {
      bankProcess.kill('SIGKILL');
    } catch (e) {}
    bankProcess = null;
  }
}

function startFee(env = {}) {
  stopFee();
  return new Promise((resolve) => {
    feeProcess = spawn('node', ['fee-service.js'], {
      env: { ...process.env, PORT: FEE_PORT, BANK_URL, ...env },
      stdio: 'pipe'
    });
    feeProcess.stdout.on('data', (d) => {
      // console.log(`[FEE OUT] ${d}`);
    });
    setTimeout(resolve, 600);
  });
}

function stopFee() {
  if (feeProcess) {
    try {
      feeProcess.kill('SIGKILL');
    } catch (e) {}
    feeProcess = null;
  }
}

// Bắt đầu chuỗi kiểm thử
async function runAllTests() {
  const chosenSituation = process.argv[2] ? parseInt(process.argv[2], 10) : null;

  console.log('================================================================');
  if (chosenSituation) {
    console.log(`BẮT ĐẦU MÔ PHỎNG RIÊNG TÌNH HUỐNG ${chosenSituation} (LAB 3 - PTIT)`);
  } else {
    console.log('BẮT ĐẦU CHẠY KIỂM THỬ TẤT CẢ 4 TÌNH HUỐNG (LAB 3 - PTIT)');
  }
  console.log('================================================================\n');

  try {
    // Khởi động Fee Service trước
    console.log('[SETUP] Khởi động Fee Service (port 4001)...');
    await startFee();

    // ==================================================================
    // TÌNH HUỐNG 1: Ngân hàng không kết nối được, rồi hoạt động lại
    // ==================================================================
    if (!chosenSituation || chosenSituation === 1) {
      console.log('----------------------------------------------------------------');
      console.log('TÌNH HUỐNG 1: Ngân hàng chưa chạy -> Gọi thanh toán -> Bật ngân hàng');
      console.log('----------------------------------------------------------------');
      stopBank(); // Đảm bảo Bank đang tắt

      // 1.1 Gọi thanh toán khi Bank tắt
      console.log('1.1. Gọi POST /students/1/payments khi Bank tắt...');
      const t1_res1 = await httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 100000 });
      console.log(`   - HTTP Status: ${t1_res1.statusCode} (Kỳ vọng: 503)`);
      console.log(`   - Phản hồi:`, t1_res1.data);
      console.log(`   - Thời gian: ${t1_res1.duration}ms (Kỳ vọng: < 1500ms)`);
      if (t1_res1.statusCode === 503 && t1_res1.duration < 1500 && t1_res1.data?.status === 'FAILED') {
        console.log('   => [PASS] Đạt tiêu chí Fail Fast 503 trong < 1.5s khi Bank tắt');
      } else {
        console.error('   => [FAIL] Không đạt tiêu chí');
      }

      // 1.2 Kiểm tra Fee Service còn sống, GET /fees phản hồi nhanh
      console.log('1.2. Gọi GET /students/1/fees kiểm tra Fee Service...');
      const t1_fees = await httpRequest(`${FEE_URL}/students/1/fees`);
      console.log(`   - HTTP Status: ${t1_fees.statusCode} (Kỳ vọng: 200)`);
      console.log(`   - Thời gian: ${t1_fees.duration}ms (Kỳ vọng: cực nhanh)`);
      console.log(`   - Dữ liệu:`, t1_fees.data);
      if (t1_fees.statusCode === 200 && t1_fees.duration < 200) {
        console.log('   => [PASS] Fee Service không sập, xem công nợ tức thì');
      }

      // 1.3 Khởi động Bank lên, gọi lại thanh toán mà KHÔNG khởi động lại Fee Service
      console.log('1.3. Khởi động Bank Service...');
      await startBank();
      const t1_res2 = await httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 100000 });
      console.log(`   - HTTP Status: ${t1_res2.statusCode} (Kỳ vọng: 201)`);
      console.log(`   - Phản hồi:`, t1_res2.data);
      if (t1_res2.statusCode === 201 && t1_res2.data?.status === 'PAID') {
        console.log('   => [PASS] Thanh toán thành công 201 ngay khi Bank hoạt động lại!');
      } else {
        console.error('   => [FAIL] Không đạt 201');
      }
    }

    // ==================================================================
    // TÌNH HUỐNG 2: Ngân hàng phản hồi rất chậm (DELAY_MS=5000)
    // ==================================================================
    if (!chosenSituation || chosenSituation === 2) {
      console.log('\n----------------------------------------------------------------');
      console.log('TÌNH HUỐNG 2: Ngân hàng quá tải, DELAY_MS=5000');
      console.log('----------------------------------------------------------------');
      console.log('[SETUP] Khởi động Bank với DELAY_MS=5000...');
      await startBank({ DELAY_MS: 5000 });

      // 2.1 Đo 1 request thanh toán
      console.log('2.1. Gửi 1 thanh toán và đo thời gian timeout...');
      const t2_res1 = await httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 100000 });
      console.log(`   - HTTP Status: ${t2_res1.statusCode} (Kỳ vọng: 504)`);
      console.log(`   - Phản hồi:`, t2_res1.data);
      console.log(`   - Thời gian: ${t2_res1.duration}ms (Kỳ vọng: ≤ 4500ms)`);
      if (t2_res1.statusCode === 504 && t2_res1.data?.status === 'PENDING' && t2_res1.duration <= 4500) {
        console.log('   => [PASS] Trả 504 PENDING trong ≤ 4.5s');
      } else {
        console.error('   => [FAIL] Không đạt tiêu chí thời gian hoặc status');
      }

      // 2.2 Bắn cùng lúc 20 thanh toán và trong lúc đó gọi GET /students/1/fees
      console.log('2.2. Bắn 20 thanh toán đồng thời và gọi GET /fees...');
      const p20 = Array.from({ length: 20 }).map(() =>
        httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 10000 })
      );

      // Chờ 500ms để 20 request đều đã gửi đi và đang pending
      await sleep(500);
      const t2_fees_start = Date.now();
      const t2_fee_check = await httpRequest(`${FEE_URL}/students/1/fees`);
      const t2_fees_duration = Date.now() - t2_fees_start;
      console.log(`   - GET /students/1/fees phản hồi trong: ${t2_fees_duration}ms (Kỳ vọng: < 300ms)`);
      console.log(`   - Dữ liệu GET /fees:`, t2_fee_check.data);
      if (t2_fees_duration < 300 && t2_fee_check.statusCode === 200) {
        console.log('   => [PASS] GET /fees vẫn phản hồi < 300ms khi 20 payment đang nghẽn!');
      } else {
        console.error('   => [FAIL] GET /fees bị chậm');
      }

      // Đợi 20 request kia kết thúc
      await Promise.all(p20);
    }

    // ==================================================================
    // TÌNH HUỐNG 3: Duy trì kết nối TCP (200 thanh toán, 10 concurrent)
    // ==================================================================
    if (!chosenSituation || chosenSituation === 3) {
      console.log('\n----------------------------------------------------------------');
      console.log('TÌNH HUỐNG 3: Duy trì kết nối TCP (HTTP Keep-Alive)');
      console.log('----------------------------------------------------------------');
      console.log('[SETUP] Khởi động Bank bình thường...');
      await startBank();
      await httpRequest(`${FEE_URL}/reset`, { method: 'POST' }); // Reset nợ

      console.log('3.1. Gửi 200 thanh toán (10 concurrent, 1.000đ mỗi lần)...');
      const totalRequests = 200;
      const concurrency = 10;
      let completed = 0;
      let successCount = 0;

      const t3_start = Date.now();
      async function worker() {
        while (completed < totalRequests) {
          completed++;
          const res = await httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 1000 });
          if (res.statusCode === 201 && res.data?.status === 'PAID') {
            successCount++;
          }
        }
      }

      const workers = Array.from({ length: concurrency }).map(() => worker());
      await Promise.all(workers);
      const t3_duration = Date.now() - t3_start;

      // Đọc stats từ Bank
      const bankStats = await httpRequest(`${BANK_URL}/stats`);
      console.log(`   - Tổng thời gian: ${t3_duration}ms`);
      console.log(`   - Số thanh toán thành công: ${successCount}/${totalRequests} (Kỳ vọng: 200/200)`);
      console.log(`   - Bank stats:`, bankStats.data);
      console.log(`   - Số kết nối TCP đã mở: ${bankStats.data?.connections} (Kỳ vọng: ≤ 20)`);

      if (successCount === 200 && bankStats.data?.connections <= 20) {
        console.log('   => [PASS] 200/200 thành công và TCP connections ≤ 20!');
      } else {
        console.error('   => [FAIL] Không đạt tiêu chuẩn TCP connection pooling');
      }

      // 3.2 Nhàn rỗi 6 giây và gọi tiếp
      console.log('3.2. Chờ 6 giây (quá thời hạn 5s idle của ngân hàng)...');
      await sleep(6500);
      console.log('   - Gửi tiếp 5 thanh toán sau nhàn rỗi...');
      let idleSuccess = 0;
      for (let i = 0; i < 5; i++) {
        const res = await httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 1000 });
        if (res.statusCode === 201) idleSuccess++;
      }
      console.log(`   - Kết quả sau nhàn rỗi: ${idleSuccess}/5 thành công`);
      if (idleSuccess === 5) {
        console.log('   => [PASS] Socket tái tạo thông suốt sau thời gian nhàn rỗi!');
      }
    }

    // ==================================================================
    // TÌNH HUỐNG 4: Đứt giữa chừng, lỗi tạm thời, bị từ chối
    // ==================================================================
    if (!chosenSituation || chosenSituation === 4) {
      console.log('\n----------------------------------------------------------------');
      console.log('TÌNH HUỐNG 4: Đứt giữa chừng, lỗi tạm thời, từ chối');
      console.log('----------------------------------------------------------------');

      // 4.a: DROP_RATE = 0.3
      console.log('\n4.a. Kiểm tra DROP_RATE=0.3 (60 thanh toán lần lượt)...');
      await startBank({ DROP_RATE: '0.3' });
      await httpRequest(`${FEE_URL}/reset`, { method: 'POST' }); // Nợ ban đầu: 50.000.000

      let dropPaidCount = 0;
      let dropPendingCount = 0;
      for (let i = 1; i <= 60; i++) {
        const res = await httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 100000 });
        if (res.statusCode === 201 && res.data?.status === 'PAID') {
          dropPaidCount++;
        } else if (res.statusCode === 504 && res.data?.status === 'PENDING') {
          dropPendingCount++;
        }
      }

      const dropStats = await httpRequest(`${BANK_URL}/stats`);
      const dropDebt = await httpRequest(`${FEE_URL}/students/1/fees`);
      const expectedDebt = 50000000 - (dropPaidCount * 100000);

      console.log(`   - Số lệnh PAID thành công: ${dropPaidCount}/60 (Kỳ vọng: ≥ 54/60)`);
      console.log(`   - Số lệnh PENDING: ${dropPendingCount}`);
      console.log(`   - Bank Duplicates: ${dropStats.data?.duplicates} (Kỳ vọng: 0)`);
      console.log(`   - Bank Charges: ${dropStats.data?.charges}`);
      console.log(`   - Công nợ thực tế: ${dropDebt.data?.debt.toLocaleString('vi-VN')}đ | Kỳ vọng: ${expectedDebt.toLocaleString('vi-VN')}đ`);

      if (dropStats.data?.duplicates === 0 && dropPaidCount >= 54 && dropDebt.data?.debt === expectedDebt) {
        console.log('   => [PASS] Tình huống 4a: Duplicates = 0, PAID ≥ 54/60, công nợ giảm chính xác!');
      } else {
        console.error(`   => [FAIL] Không đạt tiêu chí 4a`);
      }

      // 4.b: FAIL_RATE = 0.3
      console.log('\n4.b. Kiểm tra FAIL_RATE=0.3 (60 thanh toán lần lượt)...');
      await startBank({ FAIL_RATE: '0.3' });
      await httpRequest(`${FEE_URL}/reset`, { method: 'POST' });

      let failPaidCount = 0;
      for (let i = 1; i <= 60; i++) {
        const res = await httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 100000 });
        if (res.statusCode === 201 && res.data?.status === 'PAID') {
          failPaidCount++;
        }
      }

      const failStats = await httpRequest(`${BANK_URL}/stats`);
      console.log(`   - Số lệnh PAID thành công: ${failPaidCount}/60 (Kỳ vọng: ≥ 54/60)`);
      console.log(`   - Bank Duplicates: ${failStats.data?.duplicates} (Kỳ vọng: 0)`);
      if (failPaidCount >= 54 && failStats.data?.duplicates === 0) {
        console.log('   => [PASS] Tình huống 4b: PAID ≥ 54/60 và Duplicates = 0!');
      } else {
        console.error('   => [FAIL] Không đạt tiêu chí 4b');
      }

      // 4.c: Vượt hạn mức 20.000.000đ
      console.log('\n4.c. Kiểm tra vượt hạn mức (Thanh toán 25.000.000đ)...');
      await startBank(); // Bank sạch
      const beforeStats = (await httpRequest(`${BANK_URL}/stats`)).data;

      const res4c = await httpRequest(`${FEE_URL}/students/1/payments`, { method: 'POST' }, { amount: 25000000 });
      const afterStats = (await httpRequest(`${BANK_URL}/stats`)).data;
      const reqDelta = (afterStats?.requests || 0) - (beforeStats?.requests || 0);

      console.log(`   - HTTP Status: ${res4c.statusCode} (Kỳ vọng: 402)`);
      console.log(`   - Phản hồi:`, res4c.data);
      console.log(`   - Số request Bank nhận được: ${reqDelta} (Kỳ vọng: đúng 1 yêu cầu, không retry)`);

      if (res4c.statusCode === 402 && res4c.data?.status === 'FAILED' && reqDelta === 1) {
        console.log('   => [PASS] Tình huống 4c: Trả 402 và Bank nhận đúng 1 request!');
      } else {
        console.error('   => [FAIL] Không đạt tiêu chí 4c');
      }
    }

    console.log('\n================================================================');
    console.log('HOÀN THÀNH TOÀN BỘ KIỂM THỬ 4 TÌNH HUỐNG!');
    console.log('================================================================');

  } catch (err) {
    console.error('Lỗi trong quá trình kiểm thử:', err);
  } finally {
    stopBank();
    stopFee();
  }
}

runAllTests();
