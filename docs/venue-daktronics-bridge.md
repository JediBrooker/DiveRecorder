# Daktronics Venue Bridge

DivingHQ emits a canonical `venue.scoreboard_state` payload over
Socket.IO and HTTP. The Daktronics bridge CLI subscribes to that payload
and writes Daktronics-friendly RTD frames for an operator laptop inside
the venue LAN.

The bridge targets Daktronics RTD/ERTD template workflows, not fixed-digit
MDP. In practice that means:

- All Sport Pro / ERTD network feed: send UDP frames to the configured
  ERTD port.
- Data Studio / Show Control / DMP workflows: map the fixed-width RTD
  fields, or use `--format json` where the venue's Data Studio setup is
  configured for JSON fields.
- Classic serial RTD ingest: write fixed-width ASCII frames to a serial
  device configured at 19200 8-N-1.

## Run

The friendliest path is from the Control Room:

1. Open the event in **Control Room**.
2. Click the header **...** menu.
3. Click **Broadcast**.
4. Choose **Venue hardware — Daktronics bridge...**.
5. Copy the test command first, then the UDP or JSON command that matches
   the venue setup.

The panel fills in the current event id and app URL so the operator does
not need to hunt for either value.

Safe dry run:

```bash
npm run venue:daktronics -- --event-id <event_uuid> --once
```

All Sport Pro / ERTD UDP feed:

```bash
npm run venue:daktronics -- \
  --app-url http://127.0.0.1:3097 \
  --event-id <event_uuid> \
  --transport udp \
  --host 192.168.0.255 \
  --broadcast \
  --data-source 4
```

`--data-source 4` derives UDP port `21040`. Override with `--port` if
the venue's Daktronics configuration shows a different port.

Data Studio-style JSON frames over TCP:

```bash
npm run venue:daktronics -- \
  --event-id <event_uuid> \
  --transport tcp \
  --host 192.168.1.50 \
  --port 21000 \
  --format json
```

Serial RTD:

```bash
npm run venue:daktronics -- \
  --event-id <event_uuid> \
  --transport serial \
  --path /dev/tty.usbserial-0001 \
  --baud 19200
```

## Field Layout

Print the full fixed-width layout with:

```bash
npm run venue:daktronics -- --help
```

The default frame contains:

- Event identity, status, type, board height, round, hold state.
- Active diver, partner, country, club, display order.
- Active dive code, position, DD, description.
- Up to 11 judge score slots.
- Dive total, running total, rank, field size.
- Top 8 leaderboard rows.

Every field is ASCII, fixed-width, space-padded, and terminated with CRLF
by default. Use `--newline lf` or `--newline none` if the venue ingest
requires it.

## Environment Variables

The CLI also accepts:

- `DIVINGHQ_URL`
- `DIVINGHQ_EVENT_ID`
- `DAKTRONICS_TRANSPORT`
- `DAKTRONICS_FORMAT`
- `DAKTRONICS_HOST`
- `DAKTRONICS_PORT`
- `DAKTRONICS_DATA_SOURCE`
- `DAKTRONICS_BROADCAST=1`
- `DAKTRONICS_PATH`
- `DAKTRONICS_BAUD`
- `DAKTRONICS_REPEAT_MS`
- `DAKTRONICS_NEWLINE`
- `DAKTRONICS_MAX_JUDGES`
- `DAKTRONICS_TOP_N`

## Operator Notes

The bridge sends an initial HTTP snapshot, then subscribes to
`venue.scoreboard_state` for live changes. It also repeats the latest
frame every second by default because many RTD consumers expect a steady
feed, not only changes. Use `--repeat-ms 0` to send only on changes.

Keep the bridge on the venue LAN. The source payload is public scoreboard
data, but broadcast RTD packets should not be sent over a public network.
