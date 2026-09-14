เอกสารนี้ใช้สำหรับนำระบบขึ้นอินเทอร์เน็ตให้คนนอกเข้าใช้ได้จริง
ถ้าจะรันบนเครื่องตัวเองเพื่อลองดูเฉย ๆ ให้ดูหัวข้อ "เริ่มใช้งานบนเครื่องพัฒนา" ใน [`README.md`](../README.md) แทน

สำหรับ pilot บน `srv1979069.hstgr.cloud` มีตัวติดตั้งผ่าน Browser Terminal ที่ [docs/bootstrap.md](bootstrap.md): รับค่าลับแบบไม่แสดงบนจอ รองรับ Gmail App Password (ส่งจาก Gmail บัญชีเดียวกัน) หรือ Brevo และตรวจ SMTP ก่อนเริ่มแอป ใช้คำสั่งที่ pin commit จากความเห็นส่งมอบของ Infrastructure Engineer

## สรุปก่อนเริ่ม

ระบบเป็น Node.js ตัวเดียว เสิร์ฟทั้ง API และหน้าเว็บ เก็บข้อมูลทั้งหมดเป็น **ไฟล์บนดิสก์** ไม่ได้ใช้ฐานข้อมูลแยก

| เก็บอะไร | ที่ไหน |
|---|---|
| สมาชิก แพ็กเกจ คำสั่งซื้อ สิทธิ์ ประวัติเช็คอิน audit log | ไฟล์ SQLite ตาม `DATABASE_PATH` (มีไฟล์ `-wal` และ `-shm` คู่กัน) |
| รูปสลิปโอนเงิน | โฟลเดอร์ตาม `SLIP_STORAGE_PATH` ต้องอยู่นอกโฟลเดอร์ที่เสิร์ฟเป็นไฟล์สาธารณะ |

ข้อจำกัดที่ตามมาและมีผลกับทุกวิธี deploy:

- **ต้องมีดิสก์ถาวร (persistent disk)** host ที่ล้างไฟล์ทุกครั้งที่ deploy จะทำให้ข้อมูลสมาชิกและสลิปหายทั้งหมด
- **รันได้แค่ instance เดียว** ถ้ารันสองตัวจะแย่ write lock ของไฟล์เดียวกัน ต้องขยายเป็นเครื่องใหญ่ขึ้น ไม่ใช่เพิ่มจำนวน instance
- **ต้องเป็น HTTPS** เบราว์เซอร์ไม่ยอมให้เปิดกล้องแท็บเล็ตบน `http://` และตัวแอปเองก็ไม่ยอมสตาร์ตถ้า `APP_ORIGIN` ไม่ขึ้นต้นด้วย `https://` ตอน `NODE_ENV=production`
- **ต้องใช้ Node.js 24** เพราะฐานข้อมูลใช้ `node:sqlite` ซึ่งเสถียรตั้งแต่ 24 (บน Node 22 ต้องเปิด flag `--experimental-sqlite` และพฤติกรรมต่างกัน) ถ้าใช้ Dockerfile ในโปรเจกต์นี้จะได้เวอร์ชันถูกอยู่แล้ว

## ค่า env ที่ต้องตั้ง — เช็กลิสต์

คัดลอกจาก [`.env.example`](../.env.example) แล้วกรอก ค่าที่ทำเครื่องหมาย **ต้องมี** ถ้าไม่ตั้งแอปจะไม่สตาร์ต

| ตัวแปร | ต้องมี | ค่าที่ควรใช้ตอนขึ้นจริง |
|---|---|---|
| `NODE_ENV` | ✔ | `production` |
| `APP_ORIGIN` | ✔ | URL ของเว็บแบบเต็ม เช่น `https://app.suklutaifitness.com` **ต้องตรงเป๊ะ** ไม่มี `/` ปิดท้าย ถ้าผิดเบราว์เซอร์จะโดนปฏิเสธด้วย 403 ทุกคำขอที่เขียนข้อมูล |
| `OTP_SECRET` | ✔ | สุ่ม 32 ไบต์: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` **เปลี่ยนเมื่อไหร่ ทุกคนหลุดออกจากระบบและ OTP ที่ค้างอยู่ใช้ไม่ได้** |
| `PROMPTPAY_ID` | ✔ | เบอร์มือถือ / เลขบัตรประชาชน 13 หลัก / e-Wallet 15 หลัก ของบัญชีที่รับเงิน **เป็นข้อมูลส่วนตัวของเจ้าของยิม ห้ามคอมมิตลง repo** |
| `SMTP_HOST` `MAIL_FROM` | ✔ | `smtp-relay.brevo.com` และที่อยู่ผู้ส่งที่ยืนยันกับ Brevo แล้ว ดูหัวข้อ "อีเมล OTP" ข้างล่าง |
| `SMTP_USER` `SMTP_PASSWORD` | ✔ บน production | **SMTP login + SMTP key** ของ Brevo ไม่ใช่ API key แอปปฏิเสธ SMTP ที่ไม่มีการยืนยันตัวตนเมื่อ `NODE_ENV=production` |
| `SMTP_PORT` `SMTP_SECURE` | | `587` + `false` สำหรับ STARTTLS (ปกติใช้อันนี้) หรือ `465` + `true` |
| `TRUST_PROXY` | | จำนวน proxy ที่อยู่หน้าแอปจริง ๆ `1` ถ้ามี Caddy/nginx/Render/Fly ชั้นเดียว `2` ถ้ามี Cloudflare ซ้อนอีกชั้น **ตั้งผิดแล้วทั้งยิมจะใช้โควตา rate limit ร่วมกันก้อนเดียวจนล็อกอินไม่ได้** |
| `DATABASE_PATH` | | ต้องอยู่บนดิสก์ถาวร ค่าปริยายใน Docker คือ `/data/gym.sqlite` |
| `SLIP_STORAGE_PATH` | | ต้องอยู่บนดิสก์ถาวรและ**นอก** `dist/` ค่าปริยายใน Docker คือ `/data/slips` |
| `SLIP_RETENTION_DAYS` | | `365` ตามนโยบายเก็บสลิป 1 ปี |
| `PORT` `HOST` | | `3000` และ `0.0.0.0` เมื่ออยู่ใน container |
| `ADMIN_EMAIL` | | ตั้ง**เฉพาะตอน deploy ครั้งแรก** เพื่อเลื่อนอีเมลนั้นเป็นแอดมิน แล้วเอาออกได้ |
| `ALLOW_DESTRUCTIVE_ROLLBACK` | | เว้นว่างไว้เสมอ ใส่ `yes` เฉพาะตอนจะรัน `db:rollback` จริง ๆ ครั้งเดียว |

## ทางเลือกที่รัน

| | HTTPS อัตโนมัติ | ดิสก์ถาวร | ค่าใช้จ่าย | เหมาะกับ |
|---|---|---|---|---|
| **A. Hostinger VPS + Docker + Caddy** | ✔ | ✔ (ดิสก์ของ VPS) | ตามแพ็กเกจ VPS ที่มีอยู่แล้ว | ใช้จริงระยะยาว แนะนำถ้ามี VPS อยู่แล้ว |
| **B. Hostinger VPS + PM2 + nginx** | ✔ (ผ่าน certbot) | ✔ | เท่ากับ A | เครื่องที่มี nginx อยู่แล้วและไม่อยากใช้ Docker |
| **C. Fly.io** | ✔ | ✔ (volume) | มีโควตาเริ่มต้นให้ทดลอง เครื่องเล็กสุดราคาต่ำ | pilot ที่ยังไม่มี VPS |
| **D. Render** | ✔ | ✔ เฉพาะแพ็กเกจ Starter ขึ้นไป | **แพ็กเกจ free ไม่มีดิสก์** | pilot ที่ยอมจ่ายเดือนละไม่กี่ดอลลาร์ |

**ข้อควรระวังเรื่อง "host ฟรี"**: host ฟรีเกือบทั้งหมด (รวม Render free) ไม่มีดิสก์ถาวร แอปจะยังรันได้ แต่ข้อมูลสมาชิก คำสั่งซื้อ และรูปสลิป **จะหายทุกครั้งที่ deploy ใหม่หรือเครื่องถูกรีสตาร์ต** ถ้าจะให้ผู้ใช้จริงลองสมัครและโอนเงิน ต้องมีดิสก์ถาวรเสมอ — ตัวเลือก C หรือ D (Starter) เป็นราคาต่ำสุดที่ยังไม่ทำข้อมูลหาย

---

## A. Hostinger VPS + Docker + Caddy (แนะนำ)

ต้องมี: VPS ที่มี Docker, โดเมนที่ชี้ A record มาที่ IP ของ VPS แล้ว, พอร์ต 80 และ 443 เปิด

```bash
git clone https://github.com/Gith-Akerit/Gym-Management-.git
cd Gym-Management-
git checkout release/pilot

cp .env.example .env
nano .env          # กรอกตามเช็กลิสต์ข้างบน และเพิ่ม APP_DOMAIN=app.example.com

docker compose up -d --build
docker compose logs -f app        # ดูจนเห็น {"event":"ready","port":3000}
```

Caddy จะขอใบรับรอง Let's Encrypt ให้เองภายในไม่กี่วินาทีหลัง DNS ชี้ถูก ไม่ต้องตั้งอะไรเพิ่มและไม่ต้องต่ออายุเอง

`docker compose up` จะรัน migrate และ seed ให้อัตโนมัติทุกครั้งที่บูต ทั้งสองคำสั่งข้ามสิ่งที่ทำไปแล้ว จึงปลอดภัยกับยิมที่มีข้อมูลอยู่แล้ว และ**ไม่ทับราคาหรือเวลาเปิดทำการที่เจ้าของยิมแก้ไว้**

อัปเดตเป็นเวอร์ชันใหม่:

```bash
docker compose exec app node -e "process.exit(0)"   # ยืนยันว่ายังรันอยู่
# สำรองก่อนเสมอ ดูหัวข้อ "สำรองและกู้คืน"
git pull
docker compose up -d --build
```

## B. Hostinger VPS + PM2 + nginx

```bash
# Node 24 (nvm หรือ NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm install -g pm2

git clone https://github.com/Gith-Akerit/Gym-Management-.git
cd Gym-Management- && git checkout release/pilot
npm ci && npm run build

cp .env.example .env && nano .env
npm run db:migrate && npm run db:seed
ADMIN_EMAIL=owner@example.com npm run db:admin

pm2 start deploy/pm2.config.cjs && pm2 save && pm2 startup

sudo cp deploy/nginx.conf /etc/nginx/sites-available/gym
sudo ln -s /etc/nginx/sites-available/gym /etc/nginx/sites-enabled/gym
sudo nano /etc/nginx/sites-available/gym     # แก้ server_name เป็นโดเมนจริง
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d app.example.com      # ออกใบรับรองและตั้งต่ออายุอัตโนมัติ
```

อัปเดต: `git pull && npm ci && npm run build && npm run db:migrate && pm2 restart gym`

## C. Fly.io

```bash
fly auth login
fly launch --no-deploy --copy-config        # ตอบ no เมื่อถามว่าจะสร้าง database
fly volumes create gym_data --size 1 --region sin
fly secrets set \
  OTP_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  APP_ORIGIN=https://<ชื่อแอป>.fly.dev \
  PROMPTPAY_ID=... MAIL_FROM=... SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... \
  ADMIN_EMAIL=owner@example.com
fly deploy
```

ได้ `https://<ชื่อแอป>.fly.dev` พร้อม HTTPS ทันที ต่อโดเมนของตัวเองภายหลังด้วย `fly certs add app.example.com` แล้วอย่าลืมแก้ `APP_ORIGIN` ตาม

## D. Render

Push branch ขึ้น GitHub แล้วสร้าง Blueprint ชี้ไปที่ [`render.yaml`](../render.yaml) กรอกค่าที่ตั้ง `sync: false` ในหน้า dashboard
`OTP_SECRET` Render สุ่มให้เองครั้งเดียวแล้วเก็บไว้ **อย่ากด regenerate** เพราะทุกคนจะหลุดออกจากระบบ

---

## อีเมล OTP

สมาชิกเข้าระบบด้วยรหัสที่ส่งทางอีเมลอย่างเดียว **ถ้าอีเมลส่งไม่ออก ไม่มีใครเข้าระบบได้เลย** จึงต้องตั้งให้เสร็จก่อนเปิดให้คนนอกใช้

### Brevo (ฟรี 300 ฉบับ/วัน)

แอปนี้ส่งอีเมลผ่าน **SMTP** ไม่ได้ใช้ REST API ของ Brevo จึงต้องใช้ **SMTP login + SMTP key** ไม่ใช่ API key (v3 key ที่ขึ้นต้นด้วย `xkeysib-`) — **ใส่ API key ลงไปจะล็อกอินไม่ผ่านและไม่มีใครได้รหัส OTP เลย**

ขั้นตอน:

1. สมัคร brevo.com **ด้วยอีเมลของยิม** (บัญชีนี้จะเป็นของยิม ไม่ใช่ของทีมพัฒนา)
2. **ยืนยัน sender**: Senders, Domains & Dedicated IPs → **Senders** → Add a sender → ใส่ที่อยู่ที่จะใช้ส่ง เช่น `noreply@suklutaifitness.com` → Brevo ส่งอีเมลยืนยันไปที่อยู่นั้น ต้องกดยืนยันให้ขึ้นสถานะ verified
   ที่อยู่นี้คือค่าที่จะใส่ใน `MAIL_FROM` **ถ้ายังไม่ verified จะส่งไม่ออก**
3. **สร้าง SMTP key**: SMTP & API → แท็บ **SMTP** → Generate a new SMTP key ตั้งชื่อเช่น `gym-pilot` → คัดลอกค่าที่ได้ **ค่านี้แสดงครั้งเดียว**
4. ในหน้าเดียวกันจะมี **Login** (มักเป็นอีเมลที่ใช้สมัคร หรือรหัสแบบ `8xxxxx001@smtp-brevo.com`) และ **Server** กับ **Port** ให้ใช้ค่าตามนี้

| ตัวแปร | ค่า | หาได้จาก |
|---|---|---|
| `SMTP_HOST` | `smtp-relay.brevo.com` | SMTP & API → SMTP → Server |
| `SMTP_PORT` | `587` | พอร์ต STARTTLS ปกติ (`465` ต้องตั้ง `SMTP_SECURE=true` ด้วย) |
| `SMTP_SECURE` | `false` | คู่กับพอร์ต 587 |
| `SMTP_USER` | **SMTP login** | SMTP & API → SMTP → Login |
| `SMTP_PASSWORD` | **SMTP key** | SMTP & API → SMTP → Generate a new SMTP key |
| `MAIL_FROM` | ที่อยู่ที่ **verified** แล้วในข้อ 2 | Senders |

ไม่ต้องแก้โค้ดอะไร เพราะแอปคุยกับ SMTP มาตรฐานอยู่แล้ว จะเปลี่ยนไปใช้ Amazon SES, Mailgun, Postmark หรือ SMTP ของโฮสต์ก็ใช้ช่องเดิมทั้งหมด

**ห้ามใช้ `@gmail.com` เป็นผู้ส่ง** เพราะ DMARC ของ Gmail จะทำให้ถูกปฏิเสธ

### ใส่ค่าลับลงเซิร์ฟเวอร์โดยไม่ให้ผ่านแชต

เจ้าของยิมเป็นคนถือ PromptPay ID และ SMTP key ทั้งสองค่าไม่ควรผ่านมือใคร วิธีที่ใช้คือเจ้าของยิมรันคำสั่งเองในหน้า Browser Terminal ของ hPanel:

```bash
cd /srv/gym
 npm run env:set -- SMTP_USER='ค่าที่ Brevo ให้' SMTP_PASSWORD='SMTP key' MAIL_FROM='noreply@...'
 npm run env:set -- PROMPTPAY_ID='08xxxxxxxx'
```

- **เว้นวรรค 1 ตัวหน้าคำสั่ง** อย่างในตัวอย่าง เชลล์ส่วนใหญ่จะไม่เก็บบรรทัดนั้นลง history
- สคริปต์**ไม่พิมพ์ค่ากลับออกมา** บอกแค่ชื่อตัวแปรว่า added/updated จอที่แชร์อยู่จึงไม่เห็นความลับ
- เขียนแบบเปลี่ยนเฉพาะบรรทัดของ key นั้น คอมเมนต์และค่าอื่นใน `.env` อยู่ครบ และเขียนผ่านไฟล์ชั่วคราวแล้ว rename ทับ ถ้าเครื่องดับกลางคันไฟล์เดิมยังอยู่ทั้งใบ
- เขียนเสร็จแล้วอ่านกลับด้วย parser ตัวเดียวกับที่ Node ใช้ ถ้าค่าที่อ่านได้ไม่ตรงกับที่สั่ง จะคืนไฟล์เดิมและแจ้งเตือน แทนที่จะปล่อยให้ key เพี้ยนไปหนึ่งตัวอักษรแล้วไปรู้ตอนสมาชิกไม่ได้รับ OTP
- ถ้าค่ามีเครื่องหมายแปลก ๆ ให้ใช้ `npm run env:set -- --stdin SMTP_PASSWORD` แล้ววางค่าทีหลัง กด Enter และ Ctrl+D

ดูว่ามีค่าอะไรตั้งไว้แล้วบ้าง (ชื่อตัวแปรอย่างเดียว ไม่แสดงค่า):

```bash
npm run env:set -- --list
```

ตั้งค่าเสร็จต้องรีสตาร์ตบริการถึงจะมีผล: `docker compose up -d` หรือ `pm2 restart gym`

### ตั้ง SPF / DKIM / DMARC

ถ้าใช้โดเมนของยิมเป็นผู้ส่ง ต้องเพิ่ม DNS record ที่ Brevo ให้มา ไม่งั้นอีเมลจะตกถังขยะเป็นส่วนใหญ่
ขั้นตอนละเอียดพร้อมค่าที่ต้องใส่และวิธีตรวจอยู่ในหัวข้อ "ทำให้อีเมล OTP ไม่ตกถังขยะ" ของ [`README.md`](../README.md)

ตรวจก่อนเปิดใช้: ส่งเข้า Gmail, Outlook และโดเมนบริษัทอย่างละ 1 บัญชี ต้องเข้ากล่องหลักภายใน 30 วินาที

---

## หลัง deploy: ตรวจ 8 ข้อนี้ก่อนบอกคนอื่นว่าใช้ได้

1. เปิด `https://<โดเมน>/api/health` ต้องได้ `{"status":"ok"}`
2. เปิดหน้าเว็บ กรอกอีเมลตัวเอง กด "รับรหัสทางอีเมล" **ต้องได้อีเมลภายใน 1 นาทีและอยู่ในกล่องหลัก**
3. เข้าด้วยอีเมลแอดมิน (ที่ตั้งไว้ใน `ADMIN_EMAIL`) แล้วกรอกข้อมูลยิมให้ครบ: เวลาเปิดทำการ เบอร์โทร ที่อยู่
4. ตั้งราคาแพ็กเกจอย่างน้อย 1 รายการแล้วเปลี่ยนสถานะเป็น active — **แพ็กเกจที่ยังไม่มีราคาจะเปิดขายไม่ได้**
5. สมัครสมาชิกด้วยอีเมลอีกใบ กดซื้อแพ็กเกจ **แล้วสแกน QR ด้วยแอปธนาคารจริงด้วยยอดจริง (ลองยอดเล็ก เช่น 1 บาท)** ข้อนี้ข้ามไม่ได้ เพราะ payload PromptPay ตรวจแบบ offline มาตลอด ยังไม่เคยผ่านแอปธนาคารจริง
6. อัปโหลดสลิป เข้าหน้าแอดมิน ติ๊ก "ตรวจกับแอปธนาคารแล้ว" แล้วอนุมัติ ต้องเห็นสิทธิ์ขึ้นในแอปสมาชิกทันที
7. เปิดหน้าแรกของสมาชิกบนมือถือจริง ให้ QR ขึ้น แล้ว**เอาแท็บเล็ตที่จะใช้จริงสแกนจอมือถือจริง** ข้อนี้ก็ข้ามไม่ได้ ซอฟต์แวร์ทดสอบแทนไม่ได้เรื่องโฟกัส แสงสะท้อน และความสว่างจอ
8. สั่งสำรองข้อมูลหนึ่งครั้งแล้ว**ลองกู้คืนบนเครื่องทดสอบ** สำรองที่ไม่เคยกู้คืนสำเร็จไม่นับว่าเป็นสำรอง

## สำรองและกู้คืน

```bash
# Docker: สำรองทั้ง volume ในคำสั่งเดียว
docker compose exec -T app sh -c 'sqlite3 "$DATABASE_PATH" ".backup /data/backup.sqlite"' 2>/dev/null \
  || docker compose stop app     # ถ้าไม่มี sqlite3 ใน image ให้หยุดบริการก่อนคัดลอก
docker run --rm -v gym-management-_gym-data:/data -v "$PWD":/out alpine \
  tar czf /out/gym-backup-$(date +%F).tar.gz -C /data .
docker compose start app
```

```bash
# PM2: หยุดบริการชั่วครู่แล้วคัดลอกให้ครบทั้งสามไฟล์
pm2 stop gym
cp data/gym.sqlite data/gym.sqlite-wal data/gym.sqlite-shm /backup/ 2>/dev/null
tar czf /backup/slips-$(date +%F).tar.gz data/slips
pm2 start gym
```

ตั้ง cron ให้ทำทุกวันและเก็บย้อนหลังอย่างน้อย 7 วัน ขั้นตอนกู้คืนและแผนย้อนกลับเมื่อ deploy แล้วมีปัญหาอยู่ในหัวข้อ "แผนย้อนกลับ" ของ [`README.md`](../README.md)

รูปสลิปเป็นข้อมูลส่วนบุคคล เก็บ 1 ปีตามนโยบาย ตั้ง cron ให้ลบของเก่าเดือนละครั้ง:

```bash
0 3 1 * * cd /srv/gym && npm run slips:prune
```

## สิ่งที่ยังต้องทำด้วยของจริงเท่านั้น

ทั้งสามข้อนี้ QA ยืนยันว่าทดสอบด้วยซอฟต์แวร์แทนไม่ได้ และต้องทำก่อนเปิดให้สมาชิกจริงใช้

1. **สแกน QR PromptPay ด้วยแอปธนาคารจริง** อย่างน้อย 1 ธนาคาร ด้วยยอดเล็ก
2. **สแกน QR เช็คอินด้วยแท็บเล็ตเครื่องที่จะใช้จริง** ส่องจอมือถือจริง
3. **ส่งอีเมล OTP เข้ากล่องหลัก** ของ Gmail, Outlook และโดเมนบริษัท
