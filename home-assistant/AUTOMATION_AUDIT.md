# Home Assistant automation audit — 2026-10-25

Read-only audit of the 11 automations on HA 2026.8.3 (states, automation/script
configs, device registry via templates, config entries). **Nothing was changed.**

Status at audit time: 4 on, 5 off (disabled), 2 `unavailable` (broken config).

## Root causes (fix these first — they break several automations at once)

| # | Problem | Evidence | Breaks | Fix |
|---|---------|----------|--------|-----|
| R1 | **Caleb's phone isn't reporting location** | `device_tracker.caleb_s_phone` and `device_tracker.caleb_s_phone_2` both `unknown` since 2026-08-26 (two Companion-app registrations) | Coming Home, Leaving Home, Wife is home, Leaving Home Destiny | In the Companion app on the Samsung: Location → *Allow all the time*, disable battery optimisation. Delete the stale duplicate mobile_app entry. |
| R2 | **Caleb's person entity follows Destiny's iPhone** | `person.caleb_greene` trackers include `device_tracker.iphone` (Destiny's phone) and it's the current `source` | Anything using `person.caleb_greene` (and the map) | Settings → People → Caleb → remove *Destiny's phone*. |
| R3 | **All Google Cast devices unavailable** since 2026-08-26 (cast integration *loaded*, 0 live entities) and **both Android TV Remote entries in `setup_retry`** ("Couldn't connect to 192.168.1.111 / .134") | speakers, Nest Hubs, Chromecasts, Google TV Streamer | Alarms, all TTS, Night time TV control, Wife is home, Firemote | Devices likely changed IP or moved network. Give them DHCP reservations, make sure HA is on the same subnet/mDNS, then reconfigure Android TV Remote with the new IPs. |
| R4 | **Hallway Zigbee motion sensor dead** | Third Reality 3RMS16BZ (`binary_sensor.motion_sensor_motion`) `unavailable` since 2026-08-26 | Night time + Morning Time motion triggers | Replace battery / re-pair in ZHA. |
| R5 | **Deleted devices still referenced** (device triggers use registry IDs) | basement occupancy sensor `f3f5ad61…` gone; living-room bulbs `light.living_room_1/2/3` (and devices `08858152…`, `e0a8755c…`, `282eee39…`) gone | Basement ×2, Toggle Living Room Lights, `script.living_room_lights` | Re-point to existing entities (below). Prefer entity-based triggers/targets over device ones going forward. |
| R6 | **Living Room area has no lights** | `area_entities('living_room')` contains TVs, speakers, cameras, printer — zero lights. The lamp is in *Lamp Room* | Every `light.turn_off/on area: living_room` (Wife is home, Night time, Morning Time) is a silent no-op | Move `light.living_room_lamp` (and any real living-room bulbs) into the Living Room area. |

## Per-automation fix list

### 🔴 Broken

1. **Basement Lights** (`automation.basement_lights`, unavailable) — trigger device `f3f5ad61…` no longer exists.
   *Fix:* pick the current basement sensor (none is assigned to the Basement area today) or delete. Merge with #2 into one automation (`on`/`off` trigger IDs).
2. **Basement Lights off** (`automation.basement_lights_3`, unavailable) — same dead sensor. Target mixes `area: basement` + 2 devices + 3 entities for the same lights, and omits `light.basement` which the "on" automation turns on.
   *Fix:* target `area_id: basement` only. Rename entity ID to match the name.
3. **Toggle Living Room Lights** — targets `light.living_room_1/2/3`, none exist → does nothing. `script.living_room_lights` has the same problem (3 deleted devices).
   *Fix:* target the lights that are actually in the living room (likely `light.living_room_lamp`; confirm). Or simply drop it and use a tile on the dashboard.
4. **Leaving Home Destiny** — condition "Caleb's phone is *not* home" passes whenever Caleb's tracker is `unknown` (R1), so **if Destiny leaves while Caleb is home, it runs "Turn off everything" on him**.
   *Fix:* replace both "Leaving" automations with one: trigger `zone.home` state → `0` (everyone gone), or `person.*` conditions after R1/R2.
5. **Leaving Home** / **Leaving Home Destiny** — both activate `scene.coming_home`, which doesn't exist (there are no scenes at all) → that step does nothing. (The name is also backwards.)
   *Fix:* remove that step or create an "Away" scene.
6. **Wife is home** — condition requires `device_tracker.caleb_s_phone == home`; it's been `unknown` since August, so it never passes (last ran 2025-11-14). Its TTS speaker and Living Room TV are unavailable (R3), and `light.turn_off area: living_room` hits no lights (R6).
   *Fix:* after R1/R2, use `person.caleb_greene` in the condition; trigger on `person.destiny` instead of a device trigger.
7. **Music test** (actually *Alarm 1*, 05:00) and **Alarm 2** (05:05) — only output is `media_player.bedroom_speaker`, unavailable since August (R3). An alarm that fails silently is the worst kind. `input_boolean.alarm` is currently off.
   *Fix:* merge into one "Wake alarm" with two time triggers; add a fallback `notify.caleb_s_phone` (alarm-stream / critical) when the speaker isn't available; rename.

### 🟠 Logic bugs (automations are currently disabled, fix before re-enabling)

8. **Night time** (off)
   - `media_player.onn_7833x_e59d` doesn't exist (removed onn device).
   - `light.turn_off area: living_room` → no lights (R6).
   - Inner conditions use **`11:30`** (11:30 AM). "after 11:30 before 00:00" is therefore always true before midnight, and the camera step's "after 11:30 before 06:00" wraps midnight and is always true in the 22:30–02:00 window. Almost certainly meant **`23:30`**.
   - Every weekday list includes all 7 days — redundant, remove.
   - The `input_button.night_time_button` trigger is also gated by 22:30–02:00, so **pressing the Night button at 21:45 does nothing**. Give the button its own trigger ID that bypasses the time condition (or use `script.night_time_routine`, which already skips conditions).
   - Bedroom TV remote/volume steps depend on R3; the fan step is a device action (brittle) — use `switch.turn_on: switch.fan`.
9. **Morning Time** (off)
   - Same dead motion sensor (R4) and same button-gated-by-time issue (07:00–09:00 only).
   - `area: living_room` → no lights (R6).
   - Lists 7 kitchen bulbs individually **plus** the Kitchen 8 device again — use the existing `light.kitchen` group. `light.kitchen_4` (in the Kitchen area, not in the group) is left out — intended?
   - Single condition wrapped in a redundant `or`.
10. **Coming Home** (off) — only for Caleb (R1). Disables motion on 4 Blink cameras, but `script.turn_on_cameras` enables 5 (incl. *Back Yard*) — Back Yard stays armed when you're home. Make the two lists match.

### 🟡 Hygiene

- Entity IDs don't match names: `automation.basement_lights_3` = "Basement Lights off", `automation.music_test` = alarm 1. Blink: "Dog Room" uses `*_dining_room` IDs, "Back Yard" uses `*_front_door` IDs.
- 10 of 11 automations have no description.
- 8 device triggers/conditions/actions in automations (plus 12 in scripts) use registry UUIDs — this is why deleting hardware silently broke things. Switch to entity IDs.
- Duplicate stale media players: `living_room_tv_2_2/_3/_4`, `nesthub243b/_2/_3`, `nestmini*`, `chromecast4731`, `as_chromecast_cast`, `cleaning_group`.
- Other integrations failing: `ipp` (HP printer, setup_retry), `apple_tv` (not loaded).
- Updates pending: Core 2026.8.3 → 2026.10.3, OS 18.2 → 18.3.

## Suggested order
R2 → R1 → R6 → R3 → R4 → #4/#5 (merged "Everyone left") → #7 (alarm fallback) → #1–3 → #8–10 → hygiene.
