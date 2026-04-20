# Lost Ark Manage Raid Bot

Discord bot quan ly roster raid Lost Ark bang slash command va MongoDB.

## Main Features

- Sync roster tu `lostark.bible` theo combat score
- Theo doi tien do raid theo gate (`G1`, `G2`, co the mo rong `G3`)
- Set complete/reset cho toan raid hoac tung gate
- Raid leader co the scan danh sach nhan vat chua xong raid
- Weekly reset tu dong vao thu 4 sau 06:00

## Current Commands

- `/add-roster name:<character> total:<1-6 optional>`
- `/raid-status`
- `/raid-set character:<name> raid:<raid_mode> status:<complete|reset> gate:<G1|G2|G3 optional>`
- `/raid-check raid:<raid_mode>` (chi role `raid leader`)

## Project Structure

- `src/bot.js`: Khoi tao Discord client, ket noi DB, route slash command
- `src/raid-command.js`: Command schema + business logic
- `src/schema/user.js`: User/account/character schema
- `src/models/Raid.js`: Raid requirements + command choices
- `src/weekly-reset.js`: Weekly reset job
- `src/deploy-commands.js`: Dang ky slash command schema voi Discord

## Environment Variables

Copy `.env.example` thanh `.env` va dien gia tri:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id_here
GUILD_ID=your_test_server_id_here
MONGO_URI=your_mongodb_connection_string_here
MONGO_DB_NAME=manage
DNS_SERVERS=8.8.8.8,1.1.1.1
```

Luu y:

- `MONGO_URI` la bat buoc
- `CLIENT_ID`, `GUILD_ID` can cho buoc deploy slash commands
- Neu Atlas bi loi DNS (`querySrv ECONNREFUSED`), giu `DNS_SERVERS` nhu tren

## Run Local

```bash
npm install
npm run deploy:commands
npm start
```

## Data Shape (Current)

User document (rut gon):

```json
{
	"discordId": "...",
	"weeklyResetKey": "2026-W16",
	"accounts": [
		{
			"accountName": "Account 1",
			"characters": [
				{
					"id": "1",
					"name": "Clauseduk",
					"class": "Paladin",
					"itemLevel": 1730,
					"combatScore": "~4234.35",
					"assignedRaids": {
						"armoche": {
							"G1": { "difficulty": "Hard", "completedDate": 1775977578808 },
							"G2": { "difficulty": "Hard", "completedDate": 1775977578947 }
						}
					},
					"tasks": []
				}
			]
		}
	],
	"tasks": []
}
```

Trang thai hien thi trong `/raid-status`:

- `✅` khi tat ca gate cua raid da co `completedDate`
- `G1` hoac `G1/G2` khi moi xong mot phan gate
- `❓` khi chua xong gate nao

## Railway Deploy

Project da co san:

- `Dockerfile`
- `railway.toml`
- `.dockerignore`

Tren Railway, set bien moi truong nhu tren va deploy binh thuong.

## Notes

- Sau moi thay doi command schema (them/sua option, doi ten command), can chay lai:

```bash
npm run deploy:commands
```

- Neu chi sua logic xu ly ben trong command thi khong can deploy command lai.
