// 官網線上預約（免登入）。
// 送進來的東西一律只落在 bookings，不會直接變成鐘單 ——
// 技師與床位要不要排得下去，是門市看過才知道的事。
const express = require('express');
const { db, getSetting, today, nextSerial } = require('../db');
const { rateLimit } = require('../auth');

const router = express.Router();

router.get('/public/booking-info', (req, res) => {
  if (getSetting('booking_enabled', '1') !== '1') return res.json({ enabled: false });
  res.json({
    enabled: true,
    company_name: getSetting('company_name', 'RelaxCare'),
    notice: getSetting('booking_notice', ''),
    stores: db.prepare('SELECT id,name,phone,address,open_time,close_time FROM stores WHERE active = 1 ORDER BY id').all(),
    services: db.prepare('SELECT id,name,category,minutes,price FROM services WHERE active = 1 ORDER BY seq, category, name').all(),
    // 只給花名與級別，不給電話與本名
    therapists: db.prepare("SELECT id, COALESCE(NULLIF(nickname,''), name) AS name, code, level, store_id, gender FROM therapists WHERE active = 1 ORDER BY code").all()
  });
});

router.post('/public/booking', rateLimit({ windowMs: 10 * 60 * 1000, max: 10, prefix: 'bk:' }), (req, res) => {
  if (getSetting('booking_enabled', '1') !== '1') return res.status(400).json({ error: '目前未開放線上預約' });
  const b = req.body || {};
  const name = String(b.name || '').trim(), phone = String(b.phone || '').trim();
  if (!name || !phone) return res.status(400).json({ error: '請填寫姓名與聯絡電話' });
  if (!/^[0-9+\-() ]{8,20}$/.test(phone)) return res.status(400).json({ error: '電話格式看起來不正確' });
  if (!b.prefer_date) return res.status(400).json({ error: '請選擇希望的日期' });
  if (String(b.prefer_date) < today()) return res.status(400).json({ error: '日期不能早於今天' });
  const no = nextSerial('BK');
  const info = db.prepare(`INSERT INTO bookings(booking_no,store_id,name,phone,line_id,service_id,therapist_id,
      prefer_date,prefer_time,pax,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(no, b.store_id ? Number(b.store_id) : null, name, phone, String(b.line_id || ''),
      b.service_id ? Number(b.service_id) : null, b.therapist_id ? Number(b.therapist_id) : null,
      String(b.prefer_date), String(b.prefer_time || ''), Number(b.pax) || 1, String(b.note || '').slice(0, 500));
  res.json({ ok: true, booking_no: no, id: info.lastInsertRowid,
    message: getSetting('booking_notice', '我們會盡快與您聯繫確認。') });
});

module.exports = router;
