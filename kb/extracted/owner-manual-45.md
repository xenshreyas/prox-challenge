# Wiring Schematic

*(Page contains a full electrical wiring schematic diagram for the Vulcan OmniPro 220 welder. No body text paragraphs or tables appear on this page other than the schematic itself and the footer.)*

### FIGURE: wiring-schematic-full
**Caption:** none (section heading above diagram reads "Wiring Schematic")
**Type:** schematic
**Description:** Full electrical wiring schematic of the welder power and control circuitry, oriented sideways (rotated) on the page. Major blocks and labeled elements visible:

- **Input power section (bottom left):** "K1 AC 120-240V/50/60HZ" switch feeding two lines labeled "AC1" and "AC2", with a ground symbol "G". Lines pass through what appear to be fuses/inductors labeled "1/4" (four instances) before continuing into the main circuit. A transformer and rectifier bridge follow, leading into a block labeled "RECTIFIER" with pin numbers 1, 2, 3, 4.
- **PFC / IGBT power stage (center):** A boxed section labeled "IGBT" containing transistor symbols, connected to a block labeled "PFC" (Power Factor Correction). Diodes and capacitors surround this stage. A transformer core labeled with part number "T60/32*28" connects primary/secondary coils with pins 1, 2, 3, 4, 5, 6.
- **Secondary switching stage:** Two more IGBT transistor pairs (shown as circles with transistor symbols) feeding into a transformer, with associated diodes, resistors, and capacitors, leading toward the output rectification network at the top (Hall sensor, inductor, capacitors, diode bridge array) that produces the final DC output terminals labeled **"OUT+"** and **"OUT-"**.
- **CN1 connector:** shown near the top-left, connecting the output stage wiring.
- **MCU BOARD:** A large labeled block (center) with numbered pin headers 1 through roughly 34, connecting to connector **CN5** and **CN7**. Contains three small driver/optocoupler circuit blocks (each showing a transistor-like symbol) internally.
- **LCD SCREEN:** A labeled box connected via connector **CN9** (pins 1-4) to the MCU board area, representing the display module.
- **CN6:** connects to a "FAST WIRE FEED SWITCH" (shown as a simple switch symbol).
- **CN3:** connects to a "SOLENOID VALVE" (labeled once, with a second "SOLENOID VALVE" block also shown, i.e., two solenoid valve connections).
- **CN4:** connects to "WIRE FEEDER" motor, symbol labeled "M".
- **CN7 / CN8:** connect to a block labeled **"REMOTE BOARD"** with pin headers (CN1, CN2, CN3 sub-connectors on that board), which in turn connects to two circular connectors labeled **"AVIATION PLUG"** (two separate aviation-style connectors shown as circles).
- **FAN2** and **FAN**: two connectors (each with pins 1, 2) at the bottom, wired to two large square fan units depicted as circles with X-shaped blade cross patterns (two cooling fans shown at the bottom of the diagram).
- Various small components throughout: capacitors (parallel line symbols), diodes (arrow/bar symbols), resistors (rectangle or zigzag symbols), and a component labeled "Hall" (Hall-effect current sensor) near the OUT+ line.
- Sidebar tabs on the right edge of the page (standard manual navigation tabs, not part of the schematic): SAFETY, CONTROLS, WIRE, TIG / STICK, WELDING TIPS, MAINTENANCE (MAINTENANCE tab is highlighted/active in black).
- Footer text: "Item 57812", "For technical questions, please call 1-800-444-3353.", "Page 45".

**Answers questions like:**
- What does the internal wiring schematic of the Vulcan OmniPro 220 look like?
- Which connector (CN number) powers the wire feeder motor?
- Which connector controls the solenoid gas valve(s)?
- How is the LCD screen connected to the MCU board?
- What connects to the "fast wire feed switch"?
- How many cooling fans does the unit have and how are they wired (FAN, FAN2)?

## Footer
Item 57812 | For technical questions, please call 1-800-444-3353. | Page 45

```yaml
page: 45
doc: owner-manual
section: Wiring Schematic
topics: [wiring-schematic, mcu-board, lcd-screen, solenoid-valve, wire-feeder, remote-board, aviation-plug, cooling-fans, igbt, pfc, rectifier]
processes: [general]
has_table: false
has_figure: true
figure_slugs: [wiring-schematic-full]
key_facts:
  - "Page 45 contains the full Wiring Schematic diagram for the Vulcan OmniPro 220 (Item 57812)."
  - "The MCU BOARD is the central control board connecting to CN5 and CN7 headers."
  - "The LCD SCREEN connects to the control board via connector CN9."
  - "CN6 connects to the fast wire feed switch."
  - "CN3 connects to solenoid valve(s) for gas control."
  - "CN4 connects to the wire feeder motor (labeled M)."
  - "CN7/CN8 connect to a REMOTE BOARD, which connects to two aviation plug connectors."
  - "The unit has two cooling fans, connected via connectors labeled FAN and FAN2."
  - "Input power section is labeled K1 AC 120-240V/50/60HZ with AC1, AC2, and ground (G) lines."
  - "The power stage includes a RECTIFIER, PFC (Power Factor Correction), and IGBT transistor blocks."
  - "A Hall-effect sensor (labeled 'Hall') is located near the OUT+ output line."
  - "Final DC output terminals are labeled OUT+ and OUT-."
  - "For technical questions, call 1-800-444-3353."
```
