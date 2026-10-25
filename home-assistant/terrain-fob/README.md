# Terrain key-fob bridge (OnStar replacement for at-home commands)

Lock / unlock / remote start the 2022 GMC Terrain from Home Assistant by
"pressing" the buttons of a spare key fob with an ESP32. No subscription.
Works only within fob range of where the board is mounted (garage area).

```
Home Assistant ──Wi-Fi──► ESP32 (ESPHome) ──optocouplers──► spare fob buttons ──RF──► Terrain
                               └──P-MOSFET──► fob power (OFF when idle)
```

## Safety rules (push-button start + garage)
1. **Fob is unpowered when idle.** A powered fob near the car lets anyone in the
   garage open and push-start it. The ESP32 only powers the fob for ~2 s per command.
2. **Mount it inside the house**, 10+ ft from where the car parks, not in the garage.
   Button RF (~30–60 ft) still reaches; the car's short-range key detection (~3–6 ft) won't.
3. **Remote start only with the garage door open** (carbon monoxide). The Home Assistant
   Start button is gated on a garage-door sensor; don't remove that guard.

## Parts (≈ $40–120)
| Part | Notes |
|---|---|
| Spare fob | Match the **FCC ID** and button layout (Lock, Unlock, Remote start, Panic) of your current fob. Program it: check the owner's manual for *"Programming with Recognized Transmitters"* (GM often allows this with two working keys, free); otherwise a locksmith/dealer. |
| ESP32 dev board | Any ESP32-WROOM DevKit (USB powered). |
| 3 × PC817 optocouplers | One per button: Lock, Unlock, Remote start. |
| 3 × 330 Ω resistors | LED side of each PC817. |
| 1 × P-channel MOSFET (e.g. AO3401) + 10 kΩ + NPN (2N3904) + 1 kΩ | High-side switch for fob power. |
| Thin wire, solder, small enclosure, USB power supply | |
| Garage door sensor | Tilt/contact sensor or smart opener in HA (needed for the Start guard). |

## Wiring
- **Fob power:** remove the coin cell. ESP32 3V3 → MOSFET source; MOSFET drain → fob `+` battery contact;
  fob `−` → ESP32 GND. MOSFET gate pulled up to 3V3 (10 kΩ), pulled down by the NPN
  (base ← GPIO25 via 1 kΩ). GPIO25 high = fob powered.
- **Buttons:** for each button, solder the PC817 output (collector/emitter) across the
  button's two pads — collector to the pad that measures higher voltage with the fob powered.
  PC817 LED: GPIO → 330 Ω → anode, cathode → GND.
  - GPIO26 → Lock · GPIO27 → Unlock · GPIO14 → Remote start
- Test each button with the fob powered before closing the case.

## Software
`terrain-fob.yaml` is the ESPHome config. In Home Assistant: **Settings → Apps → ESPHome Device Builder**
→ New device → paste it → Install (first install over USB). Add `wifi_ssid` / `wifi_password`
to ESPHome's secrets. Home Assistant then discovers buttons:
`button.terrain_fob_lock`, `button.terrain_fob_unlock`, `button.terrain_fob_remote_start`,
`button.terrain_fob_cancel_start`.

## Remote-start sequence (GM)
Press and release **Lock**, then within ~5 s press and **hold Remote start ~4 s**
(parking lamps flash). Cancel = hold Remote start again. If your car needs a different
hold time, adjust the delays in `terrain-fob.yaml`.

## Home Assistant side (after it's built)
- Point the Car tab's Lock / Unlock / Start / Stop buttons at the `button.terrain_fob_*` entities.
- Start goes through a script that refuses unless the garage door is open.
