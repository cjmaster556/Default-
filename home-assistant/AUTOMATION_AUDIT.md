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
| R6 | **Living Room area has no lights** | `area_entities('living_room')` contains TVs, speakers, cameras, printer — zero lights. The lamp is in *Lamp Room* | Every `light.turn_off/on area: living_room` (Wife is home, Night time, Morning Time) is a silent no-op | **Decision: the Living Room has 3 lights; the Lamp stays in Lamp Room.** Those 3 bulbs are not in HA at all (none of the 28 `light.*` entities is a living-room bulb), so re-add them first (see #3), assign them to the Living Room area, and the existing `area: living_room` steps start working again. |

## Per-automation fix list

### 🔴 Broken

1. **Basement Lights** (`automation.basement_lights`, unavailable) — trigger device `f3f5ad61…` no longer exists.
   *Fix:* pick the current basement sensor (none is assigned to the Basement area today) or delete. Merge with #2 into one automation (`on`/`off` trigger IDs).
2. **Basement Lights off** (`automation.basement_lights_3`, unavailable) — same dead sensor. Target mixes `area: basement` + 2 devices + 3 entities for the same lights, and omits `light.basement` which the "on" automation turns on.
   *Fix:* target `area_id: basement` only. Rename entity ID to match the name.
3. **Toggle Living Room Lights** — targets `light.living_room_1/2/3`, none exist → does nothing. `script.living_room_lights` has the same problem (3 deleted devices).
   *Fix:* the 3 living-room bulbs need re-adding to HA (their old entities and devices were removed). Once they're back and in the Living Room area, point this automation and `script.living_room_lights` at `area_id: living_room` so future bulb swaps don't break them. The Lamp stays in Lamp Room with its own tile.
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

## Applied 2026-10-25 (backup: `backups/automations-before-2026-10-25.json`)
- **#4/#5** — `automation.leaving_home` rewritten as **Everyone left home**: triggers when `device_tracker.caleb_s_phone_2` (current Samsung) or `device_tracker.iphone` is `not_home` for 2 min; requires both to be `not_home` (fails safe while Caleb's location is `unknown`). Dead `scene.coming_home` step removed. `automation.leaving_home_destiny` turned **off** (kept for rollback).
- **#8 Night time** — enabled. Button bypasses the 22:30–02:00 window; onn player removed; weekday lists removed; fan via `switch.fan`; bedroom light now only between **23:30 and midnight**; cameras always turn on (unchanged effective behaviour).
- **#9 Morning Time** — enabled. Button bypasses the 07:00–09:00 window; kitchen bulbs → `light.kitchen` group.
- **Basement** — left as is until the sensor is fixed.
- Note for R1: Caleb's live phone is `caleb_s_phone_2` (SM-S948U); `caleb_s_phone` (SM-S928U) is an old registration to delete.
- **#7 Alarms** — renamed **Wake alarm 1 / Wake alarm 2**. If `media_player.bedroom_speaker` is unavailable/unknown, rings Caleb's phone instead (`notify.mobile_app_caleb_s_phone`: TTS on `alarm_stream_max` + high-priority notification); otherwise plays on the speaker as before (`continue_on_error`). Both Caleb phone registrations share the name "Caleb's phone", so only one `mobile_app_caleb_s_phone` service exists — delete the old registration so it's guaranteed to target the current phone.
- **Offline / low-battery alert** (new `automation.device_offline_low_battery_alert`) — notifies Caleb's phone when any Blink camera, the hallway motion sensor or the bedroom speaker is `unavailable` for 30 min, or Caleb's/Destiny's phone battery drops below 15%.
- **#3 Living Room** — `Toggle Living Room Lights` and `script.living_room_lights` now target `area_id: living_room` (no-op until the 3 Matter bulbs are paired into that area).
- **#10 Coming Home** — enabled; triggers on `device_tracker.caleb_s_phone_2`; motion-detection-off now runs `script.turn_off_cameras` (same 5 cameras as `turn_on_cameras`, incl. Back Yard).
- **Camera scripts** — device actions replaced with `switch.turn_on/off` on the 5 motion-detection switches (same cameras; Garage untouched).
- **Wife is home** — zone trigger on `device_tracker.iphone`; condition uses `device_tracker.caleb_s_phone_2`.
- R1 resolved: Caleb's Companion app background location enabled; `caleb_s_phone_2` reports `home`.
- R2 resolved: `person.caleb_greene` now tracks only `device_tracker.caleb_s_phone_2`. Old mobile_app entry "Caleb's phone" (SM-S928U) deleted; `notify.mobile_app_caleb_s_phone` now unambiguously targets the current phone.
- **Network move done** — HA wired to the living-room Deco. Cast devices are back; several re-appeared as new entities: Living Room speaker → `media_player.nestmini5941`, Living Room TV (Streamer) → `media_player.living_room_tv_4`, Bedroom TV → `media_player.bedroom_tv_3`, Kitchen Display → `media_player.nesthub243b_3`. *Wife is home* and *Night time* repointed to these. Still to do in the UI: re-pair Android TV Remote (Bedroom: "Need to pair again"; Living Room: new IP), reconfigure the HP printer, pair the 3 Matter bulbs.
- **Cync watchdog** (new `automation.cync_watchdog`) — after the network move the cync_lights integration stayed "loaded" but stopped receiving updates (all Cync lights frozen from 09:14). Fixed by reloading the config entry. The watchdog checks every 30 min (08:00–23:00, someone home); if no Cync light has updated in 6 h it reloads the integration and notifies Caleb.
- **ADB** — Android Debug Bridge added for both TVs: Bedroom (192.168.68.85, `media_player.android_tv_192_168_68_85`) and Living Room Google TV Streamer (192.168.68.51, `media_player.android_tv_192_168_68_51`), both reserved in Deco. Firemote uses ADB for its built-in app buttons; Android TV Remote handles keys. Living Room Android TV Remote re-pointed to 192.168.68.51 (no re-pair needed).
- **GMC Terrain via OnStar** — OnStar2MQTT (BigThunderSR, vehicle 1) running with Mosquitto; login via Firefox token file in `/ssl/vehicle1`. Entities `sensor.2022_gmc_terrain_2022_gmc_terrain_*`, `device_tracker.2022_gmc_terrain`, command buttons (lock/unlock/start/cancelstart/flashlights/alerthonk/cancelalert/getlocation) enabled. Car tab + Home badge on the phone dashboard. OnStar plan ends December.
- **Coming Home** now speaks "Caleb is home" on the Living Room speaker (`tts.speak` → `media_player.nestmini5941`) instead of a house-wide Google broadcast.
- **Terrain alerts** (new `automation.terrain_alerts`) — phone notification when range < 50 mi, oil life < 15%, or any tire < 30 psi.
- **Leaving Home Destiny** deleted (replaced by *Everyone left home*; its condition referenced the removed old phone). Backup in `backups/automations-before-2026-10-25.json`.
- **Template sensor** `sensor.terrain_oil_life` (helper) — OnStar oil life rounded to a whole %, used by the Car tab tile.

## Added 2026-10-25 (round 2: "everything you can do with your devices")
New: Arriving home after dark · Terrain lock reminder (+ "Terrain lock from notification" handler) · Terrain fuel reminder (TTS over Android Auto) · Caleb on his way (notifies Destiny, weekdays 4–9 PM, once/day) · First one home (indoor cameras off) · Lights left on while away (15 min) · Sunset living room · Movie mode (dim to 20% / restore via scene snapshot) · Wake-up light (10 min before alarm 1) · Night motion alert (11 PM–6 AM, camera snapshot) · Freeze warning (8 PM, hourly forecast low ≤ 32 °F) · Pause TV for porch motion · Plug auto-off (2 h).
Changed: Everyone left home now also turns on all camera motion detection · Night time also turns off the Xbox · Morning Time also turns off the fan. Backups saved as `*@pre-ideas` in the backups file.
Not built: lock-state check (OnStar doesn't report locks) and store-zone shopping nudge (no store zone yet).
- **Shopping list at the store** — when Caleb or Destiny's tracker enters a zone named Costco / Meijer / Walmart and the shopping list has items, send them the list. Zones to be created in the UI (Settings → Areas, labels & zones → Zones).
- Shopping list at the store now requires 3 minutes in the zone (Walmart is ~0.6 mi from home, so drive-bys shouldn't trigger it). Store coordinates (from Google Plus Codes): Costco 40.88594, -81.43919 · Meijer 40.84681, -81.44269 · Walmart 40.79431, -81.42231.
- Store zones created by Caleb (zone.costco / zone.meijer / zone.walmart, passive). Because passive zones don't change the tracker's state, the shopping-list automation now triggers on the tracker's `in_zones` attribute containing a store zone for 3 minutes.
- Shopping list at the store now opens the shared **Google Keep** "Shopping list" (Android: `app://com.google.android.keep`, iPhone: keep.google.com) instead of listing HA's built-in to-do list, which the family doesn't use.
- **Hallway motion sensor fixed** (battery 100%). Night time and Morning Time now trigger on `binary_sensor.motion_sensor_motion` → `on` (state trigger) instead of the old device-registry trigger, so re-pairing can't silently break them again. Night: motion only counts 22:30–02:00; Morning: 07:00–09:00; buttons work any time.
- **Basement tile** — helper group `light.basement_lights` (members `light.basement` [Cync] + `light.basement_1` [Tuya]); the phone dashboard shows one Basement tile.
- Basement presence sensor is an Aqara (Occupancy + Illuminance in the Aqara Home app); not yet in Home Assistant. Plan: share it via Matter, then repoint the two Basement automations.
- **Basement FP2 online** — Aqara FP2 (Wi-Fi, 192.168.68.52) re-paired to Home Assistant via the HomeKit Device integration (entry "Presence-Sensor-FP2-9C1D"): Light Level + 3 presence zones, all in the Basement area. New group `binary_sensor.basement_occupied` (on if ANY zone detects presence). **Basement Lights** now turns on `area basement` when it goes on; **Basement Lights off** turns the area off after 5 min of no presence. Both automations are working again (last repairs cleared). Original configs backed up as `*@pre-fp2`.

## Dropping Nabu Casa (in progress)
- **Step 1 done:** Coming Home, Wife is home, Night time and Freeze warning now speak with the free `tts.google_translate_en_com` engine through `tts.speak` on `media_player.nestmini5941` (no `home_assistant_cloud` references left). Originals saved as `*@pre-free-tts`. Optional upgrade later: Piper (local) for a nicer voice.
- **Step 2 (user):** set up Tailscale for remote access and test from the phone on mobile data. Not done yet.
- **Step 3 (user):** local/Google Drive backups. Not done yet.
- Do **not** cancel Nabu Casa until Tailscale remote access is tested (it also carries the Companion app away from home, the Google Assistant link and Claude's access).

### Nabu Casa removal: progress (2026-10-25, later)
- Step 1 done: free Google Translate TTS in 4 automations.
- Step 2 done: Tailscale app on HA (100.120.200.74, key expiry disabled); phone Companion app uses `http://100.120.200.74:8123` externally and `http://192.168.68.75:8123` on "Greene Family" Wi-Fi. Tested over 5G+ with VPN on.
- Step 3 done: Google Drive Backup add-on authenticated; encryption key saved by user.
- Step 4 done: Matter Hub (RiDDiX fork, hamh 2.0.59) bridge "Home", include-only filter for 9 lights, paired to Google Home; lights verified.
- Still to do before cancelling: wife's iPhone needs Tailscale (second `mobile_app` entry), unlink Home Assistant Cloud in Google Home, switch backup location off Cloud, then sign out of Home Assistant Cloud / cancel.

### Nabu Casa decision (2026-10-25, final)
- User chose to keep Nabu Casa. Matter Hub copies removed from Google Home and the hamh add-on stopped. Companion app back on Home Assistant Cloud.
- Kept as a backup path if Nabu is ever dropped: Tailscale on HA (100.120.200.74, no key expiry), Google Drive Backup add-on, free Google Translate TTS in the 4 automations. Matter Hub (RiDDiX fork, bridge "Home", 9 lights) can be restarted and re-paired; to cancel Nabu later also unlink Home Assistant Cloud in Google Home, move the second iPhone to Tailscale, and drop the Cloud backup location.

### Google Keep sync (2026-10-25)
- Installed HACS custom integration Google Keep Sync (watkins-matt) with a dedicated Google account (homeassistant5567@gmail.com); the family shopping list note is shared with it. Master token generated on the user's PC and typed in by the user.
- Entity `todo.google_keep_shopping_list` ("Keep Shopping list"), 15 min sync. HA → Keep verified (tick in HA ticks in Keep).
- Phone dashboard Alarm tab Lists card now uses this entity. Category headings in Keep appear as unchecked items.
- "Shopping list at the store" reminder left unchanged (still opens Keep).
- "Shopping list at the store" now reads `todo.google_keep_shopping_list` (unchecked items only, category headings that start with an emoji are skipped) and puts the count plus the first 5 items in the notification, e.g. "7 items left: Steak?, Milk, … Tap to open Keep." Backup key `1792949809843@pre-keep-count` in the backups file.
- Home tab tidy: removed the one-device "Lamp Room" section (Lamp moved to Elsewhere), renamed Fan/Fan Room to Ceiling fan/Fan light, Plug to AC plug. `light.kitchen_4` added to the Kitchen light group helper (now 8 bulbs) and its separate tile removed. Old group members saved under `group:light.kitchen@pre-merge-kitchen_4` in the backups file. Note "Morning Time" turns on `light.kitchen`, so it now includes that bulb too.
- Terrain alerts: low-fuel push threshold briefly raised to <100 mi range, then set back to <50 mi at the user's request (user was at 14.9% / 66 mi at the pump and never got the push). Backup key `1792948260584@pre-fuel-100`. The spoken Android Auto reminder (<75 mi) did fire when getting in the car. Car tab also gained a "Last command" line and an estimated remote-start indicator.
- Car tab: new template helper `binary_sensor.terrain_remote_started` (device class running): on for 15 min after a successful OnStar start unless a cancel came later. The Start control is now a tile that lights green while it is on (estimate; the car itself has the final say).
- Car tab: removed the "Last command" / estimated remote-start text card at the user's request (the Start tile lighting up is the indicator; command history is in the HA Activity log).
- Kia Soul (third-party Android Auto, no telematics): the two Terrain automations now key off the phone's Bluetooth link to `myGMC` instead of Android Auto alone. Fuel reminder gets an extra condition (myGMC connected); Lock reminder triggers 10 min after myGMC disconnects while home. "Caleb on his way" still uses Android Auto (fine for either car). Backups: `1792949709812@pre-bt-gmc`, `1792949709810@pre-bt-gmc`. The Car tab "Driving" status still uses Android Auto or Bluetooth, so it also shows Driving in the Soul.

### Voice "start the car" (2026-10-26)
- New script `script.start_the_car` ("Start the car"): presses the OnStar Start button, waits up to 2 min for OnStar's startVehicle status to change, then announces on the living room Nest Mini (`media_player.nestmini5941`, Google Translate TTS) and pushes to Caleb's phone: started, or did-not-start with OnStar's reply. Not test-run (it would start the car). To use by voice: expose the script to Google Assistant (Settings → Voice assistants → Expose) and add a Google Home routine with starter "start the car".
- `script.start_the_car` fix: OnStar2MQTT bumps the startVehicle status to "Sent" (with a new timestamp) the instant the button is pressed and to "Completed Successfully" ~19 s later. The first version stopped waiting at "Sent" and wrongly announced a failure although the car started. It now waits until the status is no longer "Sent". Backup: `script:start_the_car@pre-wait-fix`.
- `script.start_the_car` second fix (race): the OnStar timestamp changes ~1 ms before the status changes to "Sent", so the first fix could still read the old "Completed Successfully" and then fall to the failure branch ("did not start" spoken right away). Now it waits for the new timestamp, pauses 3 s, then waits for a non-"Sent" status; and it says "The car is already running." instead of sending a second start while a remote start is active. Backup: `script:start_the_car@pre-race-fix`.
- Start-the-car failure hint: new helpers `binary_sensor.terrain_driving` (Android Auto on AND phone connected to myGMC) and a history_stats count sensor "Terrain remote starts since drive" (counts OnStar startVehicle "Completed Successfully" since `terrain_driving` last changed). If a start fails and that count is >= 2, the speaker and phone say it has been remote started twice since the last drive and to start it with the key first (GM allows two in a row). Count began at 0 when created (really 2 at that moment) and corrects itself after the next drive. Backup: `script:start_the_car@pre-hint`.

### "On my way home" speaker announcement (2026-10-26)
- Companion app "Last notification" sensor enabled with allow list = Maps only (`sensor.caleb_s_phone_last_notification_2`). The Maps navigation notification carries the next turn as its title and "Arrive h:mm PM" as subText, but NOT the destination, so "navigating home" is inferred instead.
- New `proximity` helper for zone.home / Caleb's phone (`sensor.home_nearest_direction_of_travel`).
- Automation `On my way home announcement`: Maps navigation notification + phone away from home + direction of travel "towards" within 90 s -> living room Nest Mini says "Caleb is on his way home. About N minutes away." At most once an hour.
- Note: while "Disable allow list requirement" was briefly on, other apps' notifications (e.g. Netflix) were sent to HA and recorded; it is off now.
