# Vehicle reference log

Reference photos and drawings consulted (Wikimedia Commons) while correcting the procedural
vehicle models in `src/render/models/vehicles.ts` and the camo schemes in `src/render/models/unittex.ts`.
They were only looked at and measured (proportions, wheel layout, turret position and shape, gun
overhang, armour / ERA layout, distinctive fittings, paint schemes). **None of these images is shipped
with the game**: licences vary (PD, CC BY, CC BY-SA, ...), see each file page.

Gun overhangs were set from published lengths (gun forward minus hull length) rather than from photos,
whose turret traverse and perspective foreshorten barrels.

## M1A2 SEPv3 Abrams (usa_mbt)

Checked turret length / position vs hull, skirt depth, wheel size. Fix: gun overhang 2.41 m -> 1.87 m (spec 9.77 m gun forward vs 7.93 m hull), fume extractor moved out.

- File:Cav. M1A2 SEPv3.jpg (Public domain) - https://commons.wikimedia.org/wiki/File:Cav._M1A2_SEPv3.jpg
- File:M1A2 SEPV3 20150331 008.jpg (Public domain) - https://commons.wikimedia.org/wiki/File:M1A2_SEPV3_20150331_008.jpg
- File:M1A2 SEP V3 Abrams.jpg (Public domain) - https://commons.wikimedia.org/wiki/File:M1A2_SEP_V3_Abrams.jpg

## Merkava Mk4 (israel_mbt)

Wedge tip ~0.28 hull lengths behind the nose, bustle ends over the hull rear. Fix: turret shortened at the rear by 0.07 and moved back 0.05 (chain curtain, racks, panels follow), gun overhang 2.60 m -> 1.52 m (spec 9.04 / 7.60 m).

- File:Merkava-Mk-4-Barak-0001.jpg (CC BY-SA 3.0) - https://commons.wikimedia.org/wiki/File:Merkava-Mk-4-Barak-0001.jpg
- File:Merkava-Mk4m-tank-structure-ZE-01.jpg (CC BY-SA 2.0) - https://commons.wikimedia.org/wiki/File:Merkava-Mk4m-tank-structure-ZE-01.jpg
- File:Merkava4 MichaelMass01.jpg (CC BY-SA 3.0) - https://commons.wikimedia.org/wiki/File:Merkava4_MichaelMass01.jpg
- File:NGP 6692.jpg (CC BY-SA 3.0) - https://commons.wikimedia.org/wiki/File:NGP_6692.jpg

## Leopard 2A7 / 2A8 (germany_mbt)

Proportions matched; L/55 fume extractor moved to ~1/4 of the barrel, overhang 3.14 -> 3.29 m (spec 10.97 / 7.72 m). Modern 2A7/2A8 are often plain RAL 6031, the game keeps NATO 3-tone (re-derived).

- File:Tank Leopard 2A7 NATO Days 2022 (cropped).jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Tank_Leopard_2A7_NATO_Days_2022_(cropped).jpg
- File:LEOPARD 2A8 (Edited).png (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:LEOPARD_2A8_(Edited).png
- File:Leopard 2A8.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Leopard_2A8.jpg
- File:Leopard 2A8 (cropped).jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Leopard_2A8_(cropped).jpg
- File:Leopard 2A8 prototype (cropped).jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Leopard_2A8_prototype_(cropped).jpg
- File:Leopard 2A8 with Trophy system.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Leopard_2A8_with_Trophy_system.jpg

## T-90M Proryv (russia_mbt)

Relikt brows lean back ~45 deg in side view (were near vertical); overhang 2.59 -> 2.77 m (spec 9.63 / 6.86 m). 3-tone factory camo (green / sand / black edging) re-derived.

- File:T-90M.jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:T-90M.jpg
- File:The 80th Air Assault Brigade captured a T-90M Proryv tank in the Kursk region.jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:The_80th_Air_Assault_Brigade_captured_a_T-90M_Proryv_tank_in_the_Kursk_region.jpg
- File:T-90M 13.jpg (CC0) - https://commons.wikimedia.org/wiki/File:T-90M_13.jpg

## T-84 Oplot-M / BM Oplot (ukraine_mbt); T-64BV for context

Side drawing: bustle box ends well ahead of the stern - bustle shortened by 0.06; overhang 2.45 -> 2.67 m (spec 9.72 / 7.08 m). Parade BM Oplot wears a pixel scheme: Ukrainian vehicles now use a 4-colour pixel camo.

- File:T-84 Oplot drawings.png (Public domain) - https://commons.wikimedia.org/wiki/File:T-84_Oplot_drawings.png
- File:T-84 Oplat guided onto a tank transporter.jpg (CC BY-SA 2.0) - https://commons.wikimedia.org/wiki/File:T-84_Oplat_guided_onto_a_tank_transporter.jpg
- File:BM Oplots and T-64BM2, Kyiv 2021, 10.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:BM_Oplots_and_T-64BM2,_Kyiv_2021,_10.jpg
- File:BM Oplot, Kyiv 2018, 04.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:BM_Oplot,_Kyiv_2018,_04.jpg
- File:NGU T-64BV MBT.jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:NGU_T-64BV_MBT.jpg
- File:T-64BV tank, Kyiv, 2018 29.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:T-64BV_tank,_Kyiv,_2018_29.jpg
- File:T-64BV ukrainan armed forces.jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:T-64BV_ukrainan_armed_forces.jpg

## Karrar (iran_mbt)

Box skirts hang much lower (cover most of the road wheels) - skirts deepened.

- File:Karrar Great Prophet 17 (1).jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:Karrar_Great_Prophet_17_(1).jpg
- File:Karrar Great Prophet 17 (7).jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:Karrar_Great_Prophet_17_(7).jpg
- File:Karrar Great Prophet 17 (2).jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:Karrar_Great_Prophet_17_(2).jpg

## Type 99A (china_mbt)

Deep composite / ERA skirt modules along the whole run (lower edge near the hub line), large stowage cylinder on the right rear of the turret, parade woodland digital colours (light / dark green, tan); overhang 2.62 -> 3.34 m (spec 11.0 / 7.6 m).

- File:ZTZ-99A MBT 20170902.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:ZTZ-99A_MBT_20170902.jpg
- File:ZTZ-99A tank front right 20170902.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:ZTZ-99A_tank_front_right_20170902.jpg
- File:ZTZ-99A tank front 20170902.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:ZTZ-99A_tank_front_20170902.jpg
- File:ZTZ-99A MBT 20170716.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:ZTZ-99A_MBT_20170716.jpg

## K2 Black Panther (korea_mbt)

Tall slab-sided turret sits further forward over a low hull: turret moved forward 0.055, raised to 0.126; fume extractor just ahead of the mantlet.

- File:Polish army K2 Black Panther MBT 2.webp (Public domain) - https://commons.wikimedia.org/wiki/File:Polish_army_K2_Black_Panther_MBT_2.webp
- File:Polish army K2 Black Panther.webp (Public domain) - https://commons.wikimedia.org/wiki/File:Polish_army_K2_Black_Panther.webp
- File:K2 black panther3.jpg (CC BY-SA 3.0) - https://commons.wikimedia.org/wiki/File:K2_black_panther3.jpg
- File:K2 black panther.jpg (CC BY-SA 2.0 kr) - https://commons.wikimedia.org/wiki/File:K2_black_panther.jpg

## Altay (turkey_mbt)

Fume extractor near the mantlet, overhang 3.50 -> 3.00 m (spec 10.3 / 7.3 m); TSK 3-tone camo.

- File:Altay Tank.jpg (CC0) - https://commons.wikimedia.org/wiki/File:Altay_Tank.jpg
- File:TankAltayT1 (1).jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:TankAltayT1_(1).jpg
- File:Scale model of Altay.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Scale_model_of_Altay.jpg

## M2A3 Bradley (usa_apc)

BRAT reactive tiles in a grid over the upper glacis added; turret offset right with the TOW box on the left confirmed.

- File:M2a3-bradley07.jpg (Public domain) - https://commons.wikimedia.org/wiki/File:M2a3-bradley07.jpg
- File:M2A3 Bradley Security.jpg (CC BY-SA 3.0) - https://commons.wikimedia.org/wiki/File:M2A3_Bradley_Security.jpg
- File:M2A3 Bradley Fighting Vehicles in northeast Syria.jpg (Public domain) - https://commons.wikimedia.org/wiki/File:M2A3_Bradley_Fighting_Vehicles_in_northeast_Syria.jpg

## Namer (israel_apc)

Flat roof runs forward to ~0.35, then a shallow glacis to a high blunt nose (was a long wedge from mid-hull); side armour boxes run the whole upper side.

- File:IDF-Namer003.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:IDF-Namer003.jpg
- File:IDF-Nammer-CEV-05-Zachi-Evenor-v62.jpg (CC BY 2.0) - https://commons.wikimedia.org/wiki/File:IDF-Nammer-CEV-05-Zachi-Evenor-v62.jpg
- File:IDF-Nammer-66-IndependenceDay 0060.jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:IDF-Nammer-66-IndependenceDay_0060.jpg

## BMP-3 (russia_apc)

2A70 100 mm barrel is long and slim (~2.6 m out of the mantlet; was short and fat), OPVT snorkel tube stowed on the left of the roof.

- File:TB2015ExhibitionP2-42.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:TB2015ExhibitionP2-42.jpg
- File:BMP-3 (3).jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:BMP-3_(3).jpg
- File:BMP-3 0024 copy.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:BMP-3_0024_copy.jpg
- File:BMP-3 (41204909204).jpg (CC BY 2.0) - https://commons.wikimedia.org/wiki/File:BMP-3_(41204909204).jpg

## Puma (germany_apc)

Checked only (no change).

- File:Puma, first series.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Puma,_first_series.jpg
- File:SPz Puma Mobilitätsversuchfahrzeug VS2.jpg (CC BY 3.0) - https://commons.wikimedia.org/wiki/File:SPz_Puma_Mobilit%C3%A4tsversuchfahrzeug_VS2.jpg
- File:Puma IFV with MJH.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Puma_IFV_with_MJH.jpg

## Pantsir-S1 (russia_aa)

57E6 containers are bare tubes (2 x 3 per side) reaching well ahead of the turret: the enclosing box was removed, tubes lengthened.

- File:Astrakhan Victory Day Parade (May 9 2015) Pantsir-S1 P5090721 2185.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Astrakhan_Victory_Day_Parade_(May_9_2015)_Pantsir-S1_P5090721_2185.jpg
- File:Streitkräfte-Serbiens Pantsir-S1.jpg (CC BY 3.0) - https://commons.wikimedia.org/wiki/File:Streitkr%C3%A4fte-Serbiens_Pantsir-S1.jpg
- File:Bronnitsy - 01 - Pantsir-S1 SAM.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Bronnitsy_-_01_-_Pantsir-S1_SAM.jpg
- File:Pantsir-S1 (4714423748).jpg (CC BY-SA 2.0) - https://commons.wikimedia.org/wiki/File:Pantsir-S1_(4714423748).jpg

## Gepard / other AA, TELs

Checked against references where fetched; R-360 Neptune launcher moved to the KrAZ-7634HE 8x8 axle layout (was 6x6).

- File:Flugabwehrkanonenpanzer Gepard.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Flugabwehrkanonenpanzer_Gepard.jpg
- File:Gepard 1a2 overview.jpg (CC BY-SA 3.0) - https://commons.wikimedia.org/wiki/File:Gepard_1a2_overview.jpg
- File:180614-A-IY962-102 - M142 High Mobility Artillery Rocket System (HIMARS) firing during Saber Strike 18 (Image 4 of 7).jpg (Public domain) - https://commons.wikimedia.org/wiki/File:180614-A-IY962-102_-_M142_High_Mobility_Artillery_Rocket_System_(HIMARS)_firing_during_Saber_Strike_18_(Image_4_of_7).jpg
- File:180614-A-IY962-108 - M142 High Mobility Artillery Rocket System (HIMARS) firing during Saber Strike 18 (Image 7 of 7).jpg (Public domain) - https://commons.wikimedia.org/wiki/File:180614-A-IY962-108_-_M142_High_Mobility_Artillery_Rocket_System_(HIMARS)_firing_during_Saber_Strike_18_(Image_7_of_7).jpg
- File:Iskander demo Army-2016.jpg (CC BY-SA 4.0) - https://commons.wikimedia.org/wiki/File:Iskander_demo_Army-2016.jpg
- File:CombatLaunching2018-26.jpg (CC BY 4.0) - https://commons.wikimedia.org/wiki/File:CombatLaunching2018-26.jpg
## Camouflage

Vehicle schemes (`vehCamo()` in `src/render/models/unittex.ts`) were re-derived from the photos above:
US CARC tan 686A (plain), IDF Sinai grey (plain), German NATO three-tone (RAL 6031 / 8027 / 9021,
large amorphous patches with black hugging the brown), Russian T-90M factory 3-tone (green ground,
broad sand patches edged in black), Ukrainian 4-colour pixel (BM Oplot / Kyiv parades), PLA woodland
digital (Type 99A parade: light / dark green, tan, dark), ROK 4-colour woodland bands (K2), TSK
3-tone (Altay), Iranian desert sand with brown blotches (Karrar). All are generated procedurally;
no photo pixels are used.
