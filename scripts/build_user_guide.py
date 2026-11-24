from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

OUT = Path(r"C:\Users\GKarans\Desktop\BrewTracker-Pro-lietotaja-pamaciba.docx")

def shade(cell, fill):
    props = cell._tc.get_or_add_tcPr(); el = OxmlElement('w:shd'); el.set(qn('w:fill'), fill); props.append(el)

def text(paragraph, value, bold=False, size=10.5):
    run = paragraph.add_run(value); run.bold = bold; run.font.name = 'Aptos'; run._element.rPr.rFonts.set(qn('w:ascii'), 'Aptos'); run._element.rPr.rFonts.set(qn('w:hAnsi'), 'Aptos'); run.font.size = Pt(size); return run

def heading(doc, value, level=1):
    p = doc.add_paragraph(style=f'Heading {level}'); p.paragraph_format.space_before = Pt(15); p.paragraph_format.space_after = Pt(7); r=text(p, value, True, 16 if level == 1 else 12.5); r.font.color.rgb = RGBColor(0,0,0)

def bullet(doc, value):
    p = doc.add_paragraph(style='List Bullet'); p.paragraph_format.space_after = Pt(3); text(p, value)

doc = Document()
sec = doc.sections[0]; sec.top_margin = Inches(.72); sec.bottom_margin = Inches(.72); sec.left_margin = Inches(.78); sec.right_margin = Inches(.78)
styles = doc.styles; styles['Normal'].font.name = 'Aptos'; styles['Normal'].font.size = Pt(10.5)
title = doc.add_paragraph(style='Title'); title.alignment = WD_ALIGN_PARAGRAPH.LEFT; text(title, 'BrewTracker Pro lietotāja pamācība', True, 25)
p = doc.add_paragraph(); text(p, 'Fermentācijas, tvertņu, filtrācijas un pildīšanas uzskaite', False, 12)
p = doc.add_paragraph(); p.paragraph_format.space_after = Pt(15); text(p, 'Šī pamācība palīdz konsekventi ievadīt procesa faktus, lai komanda redzētu nākamos darbus un ar laiku iegūtu uzticamas fermentācijas prognozes.')

heading(doc, '1 Pirms jaunas partijas')
for item in ['Ienāc kopīgajā kontā un izvēlies savu operatora profilu ar PIN.', 'Tvertnes kartītē pārbaudi statusu. Brīva gatava nozīmē, ka vari sākt jaunu partiju. Brīva netīra nozīmē, ka vispirms jāreģistrē mazgāšana.', 'Mazgāšanā atzīmē izmantoto ķīmiju: S sārms, A akmensskābe, D dezinfekcija. Akmensskābi nedrīkst izlaist vairāk nekā divas mazgāšanas pēc kārtas.']:
    bullet(doc, item)

heading(doc, '2 Jaunas partijas ievade')
doc.add_paragraph('Ievadi alus nosaukumu, unikālu partijas numuru, tvertni, vārīšanas datumu un uzvārīto tilpumu. Pēc tam ievadi procesa mērķus: OG, FG, vārsta aizgriešanas blīvumu, Dry Hop slieksni, dzesēšanas slieksni un CO2 mērķi. Ja Dry Hop konkrētajam alum nav vajadzīgs, to atslēdz.')

heading(doc, '3 Ikdienas mērījums')
table = doc.add_table(rows=1, cols=3); table.alignment = WD_TABLE_ALIGNMENT.CENTER; table.style = 'Table Grid'
headers=['Lauks','Kad ievadīt','Kāpēc']
for i,h in enumerate(headers):
    c=table.rows[0].cells[i]; shade(c,'1D3A2B'); c.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER; p=c.paragraphs[0]; text(p,h,True,9.5).font.color.rgb=RGBColor(255,255,255)
for row in [('Datums un laiks','Vienmēr, ja ievade nav uzreiz','Pareizai fermentācijas dienai'),('Blīvums','Katru kontroli','Ātrumam, FG un sliekšņiem'),('pH','Kad iespējams','Salīdzināšanai starp vārījumiem'),('Temperatūra','Katru kontroli','Raudzēšanas un dzesēšanas kvalitātei'),('Spiediens bar','Zem spiediena','Spundēšanas kontrolei'),('CO2 vol un metode','Kad CO2 ir mērāms','Karbonizācijas lēmumam')]:
    cells=table.add_row().cells
    for i,v in enumerate(row): cells[i].vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER; text(cells[i].paragraphs[0],v,size=9)
doc.add_paragraph('Ievadi tikai faktiski nolasītas vērtības. Ja rādījums nav mērīts, atstāj to tukšu. Pārbaudi sistēmas brīdinājumu par neparastu vērtību pret aparātu pirms apstiprināšanas.')

heading(doc, '4 Darbi un procesa darbības')
doc.add_paragraph('Darbu sadaļā redzi šodienas, tuvāko trīs dienu un kavētos darbus. Vispirms darbu pieņem, lai kolēģi redz atbildīgo operatoru. Pabeidz to tikai pēc mērījuma vai darbības fakta saglabāšanas. Ja darbu nevar veikt, atliek vai izlaiž to ar paskaidrojumu.')
doc.add_paragraph('Parastā secība: aktīva fermentācija, vārsts ciet, Dry Hop ja vajadzīgs, dzesēšana uz 0 C, filtrācija uz Dzidru, pildīšana.')

heading(doc, '5 Dzesēšana filtrācija un pildīšana')
doc.add_paragraph('Pēc apstiprinātas dzesēšanas uz 0 C ikdienas fermentācijas mērījums vairs nav obligāts, ja nav novirzes vai jauna uzdevuma. Filtrējot ievadi reāli uz Dzidru aizgājušo daudzumu. Centrifūgas litri ir atsevišķs rādītājs, jo tajā ieskaitās arī discharge daudzums. No 8 t tvertnes vari filtrēt un pildīt divos ciklos; avota tvertne kļūst brīva tikai pēc pēdējā cikla.')
doc.add_paragraph('Pildīšanā ievadi datumu, FG, pH, temperatūru un CO2 vol. Kad pabeigts pēdējais cikls, tvertne kļūst Brīva netīra. Pēc mazgāšanas un dezinfekcijas tā ir Brīva gatava.')

heading(doc, '6 Analīze un līknes')
doc.add_paragraph('Analīze salīdzina pēdējās līdzīgās partijas ar visu pabeigto partiju vidējo. Mazie punkti līknēs ir īsti mērījumi. Uzved peli uz punkta, lai redzētu partijas numuru, fermentācijas dienu un vērtību. Līnija starp punktiem ir tikai vizuāls savienojums.')

heading(doc, '7 Kas visvairāk uzlabo prognozes')
for item in ['Sākumā tvertnē fiksē OG, pH, temperatūru un tilpumu.', 'Aktīvās fermentācijas laikā mēri vismaz reizi dienā.', 'Tieši pirms vārsta aizgriešanas, Dry Hop un dzesēšanas fiksē blīvumu un pH.', 'Pie katras procesa darbības fiksē temperatūru un spiedienu.', 'CO2 mērījumam norādi arī izmantoto metodi.', 'Filtrācijā un pildīšanā ievadi reālos litrus un īsu piezīmi par problēmām vai novirzēm.']:
    bullet(doc,item)

heading(doc, '8 Vēsture un rezerves kopija')
doc.add_paragraph('Vēsturiskos datus labo tikai tad, ja zini īsto vērtību, un pievieno īsu iemeslu. Vecajos BeerSmith ierakstos trūkstošie lauki paliek tukši, nevis tiek izdomāti. Pirmdienās Iestatījumos lejupielādē pilno JSON rezerves kopiju un glabā to uzņēmuma drošā mapē. Pirms lielas labošanas vai dzēšanas vispirms izveido jaunu kopiju.')

for s in doc.sections:
    footer=s.footer.paragraphs[0]; footer.alignment=WD_ALIGN_PARAGRAPH.CENTER; text(footer,'BrewTracker Pro',False,8)
OUT.parent.mkdir(parents=True, exist_ok=True); doc.save(OUT)
print(OUT)
