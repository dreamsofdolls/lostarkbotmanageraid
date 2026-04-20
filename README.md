# Lost Ark Manage Raid Bot

Bot quan ly nhan vat raid Lost Ark bang Discord slash command va MongoDB.

## Cau truc code chinh

- `src/bot.js`: Khoi tao Discord client, ket noi MongoDB, xu ly interaction
- `src/schema/user.js`: Mongoose schema cho user va danh sach nhan vat
- `src/raid-command.js`: Dinh nghia command `/add-roster`, `/check-raid` va handler

## 1) Tao Discord bot

1. Vao https://discord.com/developers/applications
2. Tao application moi
3. Vao tab **Bot** va bam **Reset Token** de lay `DISCORD_TOKEN`
4. Bat quyet `MESSAGE CONTENT INTENT` neu sau nay ban can doc noi dung tin nhan

## 2) Lay thong tin can thiet

- `CLIENT_ID`: Trong tab **General Information**
- `GUILD_ID`: ID server test (bat Developer Mode trong Discord, click phai server -> Copy Server ID)

## 3) Cau hinh bien moi truong

Tao file `.env` tu `.env.example`:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id_here
GUILD_ID=your_test_server_id_here
MONGO_URI=your_mongodb_connection_string_here
DNS_SERVERS=8.8.8.8,1.1.1.1
```

Neu gap loi `querySrv ECONNREFUSED` voi MongoDB Atlas, giu `DNS_SERVERS` nhu tren
hoac dat DNS cong cong khac (vi du `1.1.1.1,8.8.8.8`).

## 4) Moi bot vao server

Mo URL sau trong trinh duyet (thay `CLIENT_ID`):

```text
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=2147483648
```

## 5) Dang ky slash command

```bash
npm run deploy:commands
```

## 6) Chay bot

```bash
npm start
```

## Command mau

- `/add-roster name:"Mimi"`
- `/check-raid`

## Chuc nang da co

1. `/add-roster`
- Input: ten nhan vat bat ky trong roster
- Khoa chinh la Discord ID cua nguoi goi lenh
- Lay roster tu lostark.bible va chi luu top 6 nhan vat item level cao nhat
- Neu nhan vat da ton tai truoc do: giu nguyen tien do raid theo tuan

2. `/check-raid`
- Liet ke toan bo nhan vat cua user va trang thai raid trong tuan (da di/chua di)
- Bot tu reset trang thai khi sang tuan moi (theo ISO week)
