/* PDF identity swap: finding personal information and choosing its stand-ins. Rules only.
 *
 * What is found: SSNs (and masked SSNs), EINs, phone numbers, emails, street addresses, suites
 * and units, cities, states, ZIP and ZIP+4, businesses, and people's names. A name needs
 * evidence: a client folder's name, or a line that reads as a person's name and holds a known
 * name (one of the client folders' words, or a first name or surname that is not also an
 * everyday word in this folder). A form's own words, a state code or a short acronym is never a
 * name. An address counts where its city or ZIP is a real one of its state.
 *
 * What it becomes: the same length, character for character, and real where a reader could
 * check. A name becomes a real name of the same role (and gender, where the lists tell it); a
 * city becomes a real city of the same length in the same state, and its ZIP a real ZIP of that
 * city (US ZIP table, places.js); a street keeps its number of digits, direction and kind (St,
 * Ave, Calle) and takes a real street name; an SSN or EIN stays valid in form; a phone keeps its
 * area code and takes a 555-01xx number; a business keeps what kind of business it is
 * ("Consulting LLC") and changes its own name. Every stand-in uses only characters the PDF's own
 * fonts carry where it is printed, and fits the width it is printed in. One value gets one
 * stand-in across every file, folder and file name.
 */
const PDFSwapPII = (() => {
  "use strict";
  const E = () => globalThis.PDFSwapEngine;

  // ---------------------------------------------------------------- word lists
  const FEMALE = (
    "Di Jo Lu Vi Ann Ava Dee Eva Fay Ida Jan Kim Liv Mia Nia Ola Pam Sue Zoe Una Uma Ivy Abby Alma Anna Beth Cara Cora Dana Dora Elsa Emma Erin Gail Gina Gwen Hope Iris Jade Jane Joan Judy June Kara Kate Lana Leah Lena Lila Lily Lisa Lois Mary Maya Mila Nell Nina Nora Opal Olga Ines Ilse Rhea Rita Rosa Rose Ruby Ruth Sara Tara Tess Tina Vera Yara Adele Alice Amber Anita Bella Carla Carol Chloe Clara Clare Daisy Diana Edith Elena Eliza Ellen Emily Faith Fiona Grace Hazel Heidi Helen Irene Isla Joyce Julia Karen Laura Lucia Lydia Mabel Maria Megan Mirna Molly Nadia Naomi Paige Robin Rosie Sadie Sarah Sofia Stacy Susan Tessa Wanda Wendy Zelda Agnes Andrea Angela Audrey Bianca Brenda Carmen Celeste Dolores Dorothy Elaine Esther Evelyn Gloria Hannah Helena Imogen Isabel Joanna Judith Kendra Leslie Lorena Louisa Lucinda Marian Miriam Monica Odessa Pamela Rachel Ramona Regina Sharon Sheila Silvia Stella Sylvia Vivian Willow Yvonne Ursula Ingrid Isadora Octavia Abigail Adriana Beatrice Caroline Catherine Charlotte Cornelia Courtney Florence Gabriela Gertrude Henrietta Josephine Katherine Lorraine Madeline Marguerite Penelope Priscilla Rosalind Valentina Vanessa Veronica Victoria Wilhelmina Constance Evangeline Genevieve Jacqueline Rosemary Stephanie Gwendolyn Alexandra Anastasia Cassandra Christina Margaret Lucille Lillian Leonora Liliana Loretta Luciana Annette Alberta Antonia Arlene Amelia Aurora Augusta " +
    "Marisol Maribel Soledad Consuelo Araceli Yesenia Leticia Beatriz Pilar Mercedes Esperanza Graciela Marisela Yolanda " +
    "Rosalinda Lourdes Guadalupe Rosario Mariana Fernanda Daniela Gabriela Paola Natalia Alejandra Ximena Valeria Camila " +
    "Isabella Elena Lucia Luz Rocio Alondra Brenda Cristina Dulce Erika Fabiola Griselda Irma Josefina Karina Liliana Magdalena " +
    "Maricela Nayeli Noemi Norma Olivia Perla Reyna Sandra Teresa Veronica Yadira Zoraida Ashley Brittany Courtney Danielle " +
    "Heather Jennifer Jessica Kayla Kimberly Lauren Lindsey Lynette Madison Melissa Michelle Nicole Rebecca Samantha Shannon " +
    "Tiffany Whitney Allison Brooke Caitlin Haley Hailey Jenna Kelsey Kristen Mackenzie Morgan Payton Taylor Trinity Autumn"
  ).split(" ");
  const MALE = (
    "Al Bo Ed Ty Cy Mo Ben Bob Cal Dan Eli Gus Hal Ian Jay Jed Jim Joe Jon Kai Kit Lee Leo Lou Max Ned Pat Ray Rex Rob Ron Roy Sal Sam Sid Ted Tim Tom Val Wes Ike Ira Uri Ugo Adam Alan Alex Amos Andy Arlo Axel Bill Burt Carl Cole Dale Dean Drew Earl Enzo Evan Ezra Finn Gene Glen Hank Hugo Ivan Jack Jake Joel John Jose Josh Kent Kyle Lars Liam Luke Lyle Mark Matt Mike Nash Neil Noah Omar Otis Owen Paul Pete Reed Ross Ryan Sean Seth Theo Toby Todd Troy Wade Will Zack Aaron Allen Angel Basil Blake Brian Bruce Caleb Chris Colin Craig Cyrus Daryl David Diego Dylan Edgar Ethan Felix Frank Grant Henry Isaac Jason Jesse Keith Kevin Lewis Marco Mason Miles Nolan Oscar Pedro Peter Ralph Simon Scott Terry Tyler Vance Vince Wyatt Yusuf Ulric Oskar Lucas Lorenzo Leonard Alberto Andrew Antonio Arthur Austin Calvin Carter Connor Daniel Dennis Donald Easton Edward Elliot Eugene Felipe Gordon Harlan Harold Harvey Hector Howard Irving Jasper Jerome Jordan Joseph Julian Justin Marcus Martin Melvin Morgan Nathan Norman Oliver Parker Philip Rafael Raymond Robert Roland Russell Samuel Sidney Stuart Thomas Trevor Victor Walter Warren Wesley Xavier Ulysses Ignacio Orlando Ambrose Anselm Barnaby Benjamin Bernard Clarence Dominic Eduardo Emmanuel Franklin Frederick Geoffrey Harrison Jonathan Lawrence Leonardo Matthew Maximilian Nicholas Sebastian Theodore Vincent Zachary Augustine Bartholomew Christopher Montgomery Nathaniel Alexander Anderson " +
    "Mateo Santiago Alejandro Carlos Juan Luis Miguel Javier Fernando Ricardo Andres Pablo Sergio Tomas Emilio Arturo " +
    "Armando Enrique Esteban Gerardo Guillermo Jorge Manuel Mario Octavio Raul Ramon Salvador Ernesto Joaquin Rodrigo " +
    "Brandon Bradley Cody Derek Dustin Garrett Gregory Jeffrey Jeremy Joshua Kenneth Larry Patrick Randall Shawn Spencer " +
    "Stephen Timothy Travis Tristan Chase Hunter Logan Colton Brody Landon Grayson Jackson Carson Preston Weston"
  ).split(" ");
  const FIRST = FEMALE.concat(MALE);
  const LAST = (
    "Li Ng Wu Ho Yu Ma Lo Xu Ali Cox Day Fox Gee Hay Key Lee Low Lum May Orr Ray Roy Tan Wai Yee Ash Ide Iyer Ito Oda Ueda Uno " +
    "Abel Ames Bach Bain Bell Best Bird Blum Boyd Bush Cain Camp Carr Cash Chan Chen Choi Cole Cook Cruz Dahl Dale Dean Diaz Dorn " +
    "Duke Dunn Egan Ford Frey Fung Gage Gill Gray Hahn Hale Hall Hart Hays Hess Holt Hood Hook Hope Horn Hunt Hyde Ivey Kane Kerr " +
    "King Kirk Knox Koch Lamb Lane Lang Lara Lind Long Luna Lynn Mack Mann Mays Mead Moss Muir Nash Neal Noel Nunn Page Park Penn " +
    "Pike Pope Rice Rios Ross Rowe Ruiz Rush Ryan Sage Sato Shaw Shea Sims Soto Swan Tate Toth Vega Wade Wall Ward Watt Webb West " +
    "Wolf Wong Wood Yang York Zhao Oaks Ochs Otto Ivan Ingo Ulm Ury " +
    "Adler Avery Baker Banks Barry Bauer Blair Boone Bowen Boyle Brady Brand Brock Brown Burke Burns Byrne Casey Chase Clark " +
    "Cline Crane Cross Dixon Doyle Drake Duran Ellis Ernst Evans Flynn Foley Frost Gates Giles Glenn Grant Graves Gross Hagen " +
    "Hayes Healy Hines Irwin Isaac Jonas Joyce Keane Kelly Kemp Klein Knapp Lacey Lyons Major Marsh Mason Meyer Miles Moore Moran " +
    "Myers Nolan Novak Oakes Olsen Olson Owens Patel Perry Pratt Price Quinn Reyes Riley Roach Rojas Russo Sachs Sharp Silva " +
    "Sloan Smith Stone Stout Tapia Vance Voigt Walsh Wells Wolfe Wyatt Yates Young Zayas Ochoa Ortiz Ulloa Unger Upton Urban " +
    "Abbott Acosta Alvarez Archer Arnold Atkins Bailey Barnes Barton Baxter Becker Benson Berger Bishop Bolton Bowman Brandt " +
    "Briggs Brooks Bryant Butler Carver Castro Coates Conway Cooper Cortez Cullen Curtis Dalton Davies Dawson Decker Draper " +
    "Dunbar Duncan Easton Farley Fields Fowler Franco Fraser Fuller Garcia Garner Gibson Glover Gordon Graham Greene Guerra Hammond " +
    "Hansen Hardin Harmon Harper Hartley Hawkins Henson Hobbs Hooper Horton Howard Hudson Hughes Hunter Ingram Jensen Keller " +
    "Kendall Kirby Knight Landry Larsen Lawson Lowell Lucero Madden Maddox Malone Martin Mathis Medina Mercer Merritt Morgan Morris " +
    "Murphy Nelson Newman Norris Osborne Palmer Parker Patton Pearson Perkins Pierce Porter Powell Ramsey Reeves Rivera Roberts " +
    "Salazar Sanders Sawyer Schultz Sellers Shepard Snyder Spencer Stanton Stewart Sutton Tanaka Thornton Tucker Turner Vaughn " +
    "Wagner Walker Wallace Warren Watkins Weaver Webster Wheeler Whitney Wilder Willis Winters Wright Zamora Urbina Ulrich " +
    "Valdez Vargas Ortega Orozco Oliver Ibarra Isaacs Inman Quintero Quigley Zeller Zimmer Underwood Urdaneta Rosselli Hartwell " +
    "Pruitt Odom Okafor Iwasaki Ikeda Imai Ueno Ulibarri Uriarte Usher Ewing Engel Eaton Ennis Elliott Esposito Estrada Everett " +
    "Blackwell Fairbanks Gallegos Galloway Hargrove Kensington Livingston Montgomery Pemberton Remington Richardson Rutherford " +
    "Sinclair Southwick Thompson Wadsworth Whitfield Williamson Worthington Castellano Valenzuela Villanueva Echeverria Montenegro " +
    "Fitzgerald Fitzpatrick Rasmussen Lindqvist Halvorsen Underhill Hutchinson Henderson Gutierrez Rodriguez Fernandez Hernandez " +
    "Gonzalez Martinez Anderson Robinson Harrington Carrington Pennington Abernathy Delacroix Ellsworth Kirkpatrick Lancaster " +
    "Marchetti Nakamura Oyelaran Pellegrino Quarterman Silverstein Townsend Vandermeer Wainwright Yamamoto Zimmerman"
  ).split(" ");
  const STREET = (
    "Oak Elm Ash Bay Fir Sun Pine Palm Park Lake Hill View Mesa Vale Cove Glen Rock Sage Rose Wren Lark Fern Mill Dove Hawk " +
    "Aspen Birch Cedar Maple Olive Grove Ridge Brook Creek Pinos Lobos Rosas Monte Cielo Lomas Sonora Sierra Vista Pueblo Arroyo " +
    "Canyon Valley Meadow Willow Spruce Laurel Garden Harbor Summit Sunset Prairie Orchard Juniper Sequoia Mesquite Saguaro " +
    "Magnolia Sycamore Chestnut Hawthorne Cottonwood Paloma Venado Colina Rancho Lincoln Jefferson Madison Monroe Jackson " +
    "Franklin Hamilton Highland Lakeview Ridgeview Sunrise Fairview Riverside Hillcrest Westwood Kingston Lexington Ashford " +
    "Brighton Carlton Chester Dover Easton Fulton Granger Hudson Kendall Logan Milton Newport Oxford Preston Quincy Stratford " +
    "Trenton Union Warren Windsor Cypress Hemlock Linden Poplar Redwood Alder Hazel Holly Myrtle Clover Daisy Lilac Tulip " +
    "Violet Amber Silver Golden Copper Granite Marble Quartz Jasper Coral Pearl Ruby Topaz Falcon Eagle Heron Robin Finch " +
    "Quail Raven Sparrow Cardinal Bluebird Kestrel Osprey Pelican Antelope Mustang Bison Elk Fox Bear Wolf Otter Beaver " +
    "Toro Gato Cerro Playa Alamo Bonita Dorado Encanto Mirador Montana Primavera Tierra Ventana Escondido Tranquilo " +
    "Main Walnut Hickory Dogwood Locust Cherry Peach Apple Plum Beech Larch Mulberry Hawthorn Elmwood Oakwood Pinewood " +
    "Maplewood Cedarwood Ashwood Lakewood Brookwood Woodland Woodlawn Hillside Parkview Sunnyside Lakeside Seaside Bayview " +
    "Clearview Grandview Mountain Meadowbrook Brookside Creekside Riverview Country Village Church School Market Center Spring " +
    "Bridge Water Railroad Station College Liberty Adams Cleveland Kennedy Roosevelt Wilson Taylor Polk Tyler Pierce Fillmore " +
    "Hayes Garfield Arthur Truman Pleasant Prospect Forest Harvest Heritage Pioneer Frontier Mission Ranch Desert Butte Plaza " +
    "Alameda Vineyard Starlight Rainbow Evergreen Greenbriar Briarwood Foxglove Primrose Lavender Rosewood Sandstone " +
    "Flagstone Cobblestone Fieldstone Stonegate Kingsley Wellington Nottingham Sherwood Dorchester Westminster Hampton Concord " +
    "Carlisle Princeton Stanford Cambridge Yorkshire Devonshire Somerset Ashland Oakland Richland Fairfield Westfield Northfield " +
    "Springfield Greenfield Sheffield Winchester Manchester Chesterfield Ironwood Mariposa Agave Ocotillo Yucca Cholla Tamarisk " +
    "Pinon Sagebrush Bonanza Coronado Catalina Durango Linda Hermosa Corona Alta Loma Grande Verde Valle Luna Estrella " +
    "Antelope Speedway Broadway Orange Columbus Country Club"
  ).split(" ");
  // halves of English surnames, for a surname no list has at that length ("Chester" + "field")
  const SUR_HEAD = ("Ash Bel Black Bram Brad Brook Bur Cal Car Chester Craw Dal Dar Dun Ell Fair Far Fern Gar Glad Green " +
    "Ham Hart Hay Hol Kings Lang Lin Lock Mar Mel Mid Mont Nor North Oak Pem Pen Ral Red Ros Rut Sal Shel Stan Stock Thorn " +
    "Tal Wal Wes West Whit Win Wood Al Ar Ber Cran Dray Hux Kel Lind Mor Pres Rad Stam Sum Ster Wy Blan Cord Hal Kirk").split(" ");
  const SUR_TAIL = ("ford field ton wood worth ley by son man well more stone ridge dale brook ham ington ston bury wick " +
    "land hart hurst croft lock ing er ell ard ett ins ings dell mere wright sley ster stead combe borough holt leigh grove").split(" ");
  function surnames(len) {
    // two halves read most like a real surname ("Chesterfield"); a joining syllable only when
    // two halves cannot make the length
    const two = [], three = [];
    for (const h of SUR_HEAD) for (const t of SUR_TAIL) if (h.length + t.length === len) two.push(h + t);
    for (const h of SUR_HEAD) for (const mid of ["s", "en", "er", "ing"]) for (const t of SUR_TAIL)
      if (h.length + mid.length + t.length === len) three.push(h + mid + t);
    return two.length >= 6 ? two : two.concat(three);
  }
  // distinctive words for a business's stand-in; the business's kind of work keeps its own words
  const BUSINESS_WORD = (
    "Apex Arbor Atlas Aurora Beacon Birch Bluff Bright Cairn Canyon Cedar Cobalt Crest Delta Ember Fable Falcon Fern Forge " +
    "Frontier Garnet Glade Granite Harbor Haven Horizon Indigo Juniper Keystone Kestrel Lantern Lark Ledger Lumen Maple " +
    "Meridian Mesa Nimbus Northstar Oasis Onyx Orchard Pinnacle Prism Quarry Quill Rally Raven Ridge Sable Sierra Slate " +
    "Sonder Spruce Strata Summit Talon Tandem Tidal Timber Torch Vale Vantage Vertex Willow Zenith Brightline Clearwater " +
    "Copperleaf Driftwood Evergreen Fieldstone Goldcrest Highmark Ironwood Lakeshore Northwind Oakmont Pinecrest Quicksilver " +
    "Redstone Silverline Stonebridge Sunridge Timberline Westbrook Windward Bluepeak Clearpath Brightwater Silverleaf " +
    "Wildflower Crossroads Lighthouse Waypoint Cornerstone Benchmark Landmark Milestone Trailhead Riverbend Bluestone " +
    "Greystone Ironclad Northbridge Southgate Eastwind Westward Oakhaven Pinehurst Cedarline Birchwood Elmstead Ashbury " +
    "Kinetic Lucent Radiant Vivid Stellar Novus Axiom Cipher Vector Fusion Catalyst Momentum Paragon Sterling Noble Valiant " +
    "Brisk Swift Agile Nimble Ample Astra Lyra Orion Vega Nova Polaris Terra Aqua Zephyr Boreal Alpine Coastal Prairie " +
    "Harvest Heritage Legacy Pioneer Venture Quest Odyssey Voyage Compass Anchor Mariner Tidewater Seabright Sandpiper Heron " +
    "Osprey Kingfisher Arrow Basalt Beryl Cascade Copper Dune Echo Flint Grove Halcyon Ivory Jasper Kindred Lumina Marble " +
    "Opal Pebble Quartz Ripple Saffron Topaz Umber Verdant Wren Yonder Amberly Bramble Cinder Dovetail Emberly Foxtail " +
    "Glimmer Hollow Inkwell Juncture Keel Lattice Mosaic Nectar Outpost Parallax Quintet Rosewood Sextant Thistle Upland " +
    "Wavecrest Bellwether Candlewick Fernwood Gladstone Harborview Ironbridge Juniperhill Larkspur Meadowlark Northfield"
  ).split(" ");
  // a business's kind of work and its legal form: printed as they are, only the name around them changes
  const GENERIC_BUSINESS = new Set((
    "consulting consultants consultancy consultant services service solutions group holdings partners partnership management " +
    "enterprises enterprise ventures properties property realty design designs studio studios works collective communities " +
    "community retirement construction contracting contractors marketing media global international industries industry " +
    "technologies technology tech systems software labs lab network logistics transport transportation trucking freight supply " +
    "supplies dental wellness care homes home living senior law legal accounting advisors advisory equity agency associates " +
    "company corporation incorporated limited llc pllc llp inc corp co ltd and of the american national united first us usa " +
    "creative digital health medical strategies strategy development developers builders landscaping cleaning painting " +
    "plumbing electric roofing restaurant cafe bakery salon spa fitness photography events productions entertainment trading " +
    "imports exports distributors distribution manufacturing engineering architects architecture interiors therapy counseling " +
    "clinic center academy institute studio arts art realty investments"
  ).split(" "));
  // a lowercase word that may sit inside a person's name ("de la Cruz", "van Dyke")
  const PARTICLES = new Set("de del la las los van von der den da di du le y bin".split(" "));
  // what may follow a name without being part of it ("..., CPA", "Jr.")
  const CREDENTIAL = /(?:,\s*|\s+)(?:CPA|EA|ESQ|Esq|JD|MBA|CFP|PhD|PHD|MD|DDS|Jr|JR|Sr|SR|II|III|IV)\.?\s*$/;
  const HONORIFIC = /^\s*(?:Mr|MR|Mrs|MRS|Ms|MS|Miss|MISS|Dr|DR)\.?\s+/;
  // a business name: capitalized words, then its legal form
  const BUSINESS = /((?:[A-Z][A-Za-z0-9'’.]*\s+(?:(?:&|\+|and|of)\s+)?){1,6})(LLC|L\.L\.C\.|PLLC|LLP|Inc\.?|INC\.?|Corp\.?|CORP\.?|Co\.|CO\.|Company|COMPANY|Ltd\.?|LTD\.?)(?![A-Za-z])/g;
  const STATE_NAMES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
    DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
    KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
    MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
    NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
    OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
    TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
    WY: "Wyoming", DC: "District of Columbia",
  };

  // words that are never a person's name, whatever their capitals
  const NOT_NAME = new Set((
    "a an and the of to in on at by or for from with as is are be this that your you our we it if not no yes all any each other " +
    "account accounts acct statement statements tax taxes year years form forms return returns copy copies recipient recipients " +
    "payer payers filer student students borrower lender employer employee name names address addresses city state zip code " +
    "number total amount amounts income interest dividends dividend federal withheld wages box page date dated corrected void " +
    "department treasury internal revenue service services schedule summary detail details information important please see " +
    "instructions note notes period paid payments payment received receipt receipts donation donations charitable contribution " +
    "contributions gift goods provided exchange cash check credit debit balance beginning ending opening closing year-end " +
    "street avenue road drive lane way court place boulevard parkway circle terrace trail highway suite apt apartment unit floor " +
    "north south east west northeast northwest southeast southwest " +
    "calle camino paseo avenida via vista placita rancho del de la las los " +
    "january february march april may june july august september october november december " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "llc pllc inc corp co company group law lawyer lawyers office offices firm associates partners partner cpa cpas pc pa llp " +
    "trust estate family foundation church bank banks university college school district investments investment financial " +
    "capital fund funds insurance union health hospital medical clinic center centre brokerage securities custodian " +
    "mortgage loan loans savings checking retirement ira roth hsa plan plans benefits holdings partnership corporation " +
    "catholic food foster children friends goodwill organization qualifying eligible southern northern western eastern " +
    "joint tenants jtwros tod ten com wros jt tic poa trustee executor guardian custodial minor " +
    "mr mrs ms dr jr sr ii iii iv md dds esq phd " +
    "prepared preparer client clients taxpayer spouse dependent dependents organizer documents document files folder " +
    "owner owners donor member members holder holders shareholder shareholders officer director contact attention attn " +
    "signer signature beneficiary participant insured patient payee agent representative " +
    "daughter son child wife husband mother father parent parents grandchild grandson granddaughter niece nephew " +
    "stepson stepdaughter stepchild brother sister foster relationship relative none self occupation " +
    "dear hello hi greetings sincerely regards thanks thank cordially respectfully " +
    "w2 w-2 nec misc div int oid composite official enclosed package please qualified advisor planner contact " +
    "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa " +
    "kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada " +
    "hampshire jersey mexico york carolina dakota ohio oklahoma oregon pennsylvania rhode tennessee texas utah vermont virginia " +
    "washington wisconsin wyoming tucson phoenix boston"
  ).split(" "));
  const ALSO_A_WORD = new Set((
    "able about above account accounts acres act add adjusted after again against age agent all allen amount amounts and annual any apple april art ash august austin baker ball bank banks bar bass bay beach bear bell berry best bill bills bird black blanc bliss block bloom blue bond bonds booker boone bow bowl box branch brand bridge bright brook brooks brown buck bull burns bush butler cain camp candy cannon cap card carpenter carr carter case cash castle chamber chance chapel chase cherry child christmas church clay clear cliff cloud coach coast cole collins cook cool corn cotton count court cox crane cross crown cruz dale dance dash dawn day deal dean dear dove down drake duke dunn early earl east easter echo edge field fields finch fish fisher fleet flood flower floyd ford forest fortune foster fox frank free freeman friend frost fuller gale game garden gardner gates gay gem gift glass glen gold golden good goodman goss grace graham grant gray green gross grove guard guy hall ham hand hardy harmony hart harvest hawk hay heart hill hire holiday holly home hood hope horn house howard hunt hunter ivory ivy jack james jay jewel joy judge june justice keen key king knight lake lamb land lane large law lawn lee lemon level light lily little lock long lord love lucky major march mark marsh marshal martin mason may mayor mercy merry mill miller mint moon moore morning moss mountain nash net new newman noble north oak oliver page palmer paris park parker pay pearl penny pepper person pierce pike pine pitt plain player pole pope porter post potter power powers prince price pride quick rain ray reed rice rich ridge rivers robin rock rose ross rowe royal ruby rush sage sale sales salt sandy savage sawyer scott sharp shaw short silver sims slate small smart smith snow sparks spring sparrow stark steel sterling stern stone storm strong summer sun sweet swift tall taylor temple thorn tower travis trust truth tucker turner vale vance victory violet wade walker wall walls ward ware warren water waters way weaver webb well wells west wheeler white wild will williams win winter wise wolf wood woods worth wright york young " +
    "gross self head see sales son line check net loss gain cost credit loan joint single date code payment tax state city firm private standard wages"
  ).split(" "));
  const INSTITUTION = /\b(universit|college|bank|investments?|brokerage|securities|insurance|credit union|department|internal revenue|treasury|irs\b|fidelity|schwab|vanguard|morgan|chase|wells fargo|church|foundation|hospital|school district|mortgage|financial|capital|corporation|corp\b|inc\b|food bank|goodwill|custodian|services)/i;
  const LABEL = /\b(?:donor|name|recipient(?:'s)?(?: name)?|taxpayer|spouse|student(?:'s)?(?: name)?|borrower|payee|employee(?:'s)?(?: name)?|account (?:of|holder)|owner|beneficiary|participant|insured|patient|client|prepared for|dear|(?:dependent|child)(?:'s)?(?:\s*(?:#|no\.?)?\s*\d{1,2})?(?: name)?|son|daughter|qualifying (?:child|person|relative)(?: name)?)\s*:?\s+(.+)/i;

  // ---------------------------------------------------------------- small helpers
  const STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP".split(" "));
  const LABEL_WORDS = new Set(("name names address addresses recipient recipients payer payee filer taxpayer spouse student borrower lender employer employee account number street city state zip code telephone phone email date birth identification tin ssn ein box " +
    "dependent dependents child children son daughter relationship qualifying").split(" "));
  const VOWELS = "aeiou";
  const CONS = "bcdfghjklmnprstvwz";

  function rand(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
  function pick(list) { return list[rand(list.length)]; }
  /** `word` written in the style of `pattern`'s capitals (ALL CAPS, lowercase, Title Case), word
   * by word where both have as many words; a McDonald pattern is a Title Case one. */
  function copyCase(pattern, word) {
    const pw = pattern.split(/(\s+)/), ww = word.split(/(\s+)/);
    if (pw.length === ww.length && pw.length > 1) return ww.map((w, k) => (/^\s*$/.test(w) ? w : caseOfWord(pw[k], w))).join("");
    return caseOfWord(pattern, word);
  }
  function caseOfWord(pattern, word) {
    const letters = pattern.replace(/[^\p{L}]/gu, "");
    if (!letters) return word;
    if (letters === letters.toUpperCase() && letters.length > 1) return word.toUpperCase();
    if (letters === letters.toLowerCase()) return word.toLowerCase();
    // Title Case, or McDonald: the first letter as the pattern's, the rest as the word has them
    return word.replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  }
  const title = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const stem = (w) => w.replace(/['’]s$/i, "").toLowerCase();
  const isNameWord = (w) => /^[\p{L}][\p{L}'’]*[\p{L}]$/u.test(w) && !NOT_NAME.has(stem(w)) && !LABEL_WORDS.has(stem(w));
  function byLength(list) { const m = new Map(); for (const w of list) { if (!m.has(w.length)) m.set(w.length, []); m.get(w.length).push(w); } return m; }
  // The libraries (names.js): every first name the SSA's and the Census Bureau's tables carry, and
  // the 50,000 most common surnames of the 2010 census, each list most popular first. A name that
  // is also an English word ("Brown", "Page", "Self") is evidence of a name only when it is on the
  // short lists above, or among the most common names of all.
  const NAMES = globalThis.PDFSWAP_NAMES || { female: "", male: "", last: "", word: "" };
  const lib = (s) => (s ? s.split(" ") : []);
  const LIB_F = lib(NAMES.female), LIB_M = lib(NAMES.male), LIB_L = lib(NAMES.last), WORDLIKE = new Set(lib(NAMES.word));
  const plain = (list, top) => list.slice(0, top).filter((n) => !WORDLIKE.has(n.toLowerCase()));
  const uniq = (list) => [...new Set(list)];
  // what a stand-in is drawn from: popular names a reader might meet, never one that is also a word
  const FEMALE_GEN = uniq(FEMALE.concat(plain(LIB_F, 1500))), MALE_GEN = uniq(MALE.concat(plain(LIB_M, 1200)));
  const LAST_GEN = uniq(LAST.concat(plain(LIB_L, 15000)));
  // a street is often named for a person, a tree or a place: the street words and common surnames
  // street names: the list of names streets carry first; a common surname ("Johnson Ave") only
  // where no street name of about the length exists
  const STREET_GEN = uniq(STREET), STREET_SURNAMES = uniq(plain(LIB_L, 400));
  const FIRST_BY = byLength(FEMALE_GEN.concat(MALE_GEN)), LAST_BY = byLength(LAST_GEN), STREET_BY = byLength(STREET_GEN), STREET_SUR_BY = byLength(STREET_SURNAMES);
  const FEMALE_BY = byLength(FEMALE_GEN), MALE_BY = byLength(MALE_GEN), BUSINESS_BY = byLength(BUSINESS_WORD);
  const lower = (list) => list.map((w) => w.toLowerCase());
  const FEMALE_SET = new Set(lower(FEMALE.concat(LIB_F))), MALE_SET = new Set(lower(MALE.concat(LIB_M)));
  const FIRST_SET = new Set([...FEMALE_SET, ...MALE_SET]), LAST_SET = new Set(lower(LAST.concat(LIB_L)));
  const CURATED = new Set(lower(FIRST.concat(LAST)));
  const RANK_F = new Map(lower(LIB_F).map((n, i) => [n, i])), RANK_M = new Map(lower(LIB_M).map((n, i) => [n, i])), RANK_L = new Map(lower(LIB_L).map((n, i) => [n, i]));
  /** On one of the name lists: a name a person really carries, whatever it is next to. */
  const inLists = (w) => {
    const l = w.toLowerCase();
    if (CURATED.has(l)) return true;
    if (!FIRST_SET.has(l) && !LAST_SET.has(l)) return false;
    if (!WORDLIKE.has(l)) return true;
    return (RANK_F.get(l) ?? Infinity) < 300 || (RANK_M.get(l) ?? Infinity) < 300 || (RANK_L.get(l) ?? Infinity) < 1000;
  };

  // ---------------------------------------------------------------- real places
  let PLACES = null;
  /** The US ZIP table (places.js) read once: state -> its cities (and their ZIPs) and its cities
   * by length; ZIP -> its state. */
  function places() {
    if (PLACES) return PLACES;
    const states = new Map(), zipState = new Map();
    for (const [st, packed] of Object.entries(globalThis.PDFSWAP_PLACES || {})) {
      const cities = new Map(), byLen = new Map();
      for (const entry of packed.split(";")) {
        const bar = entry.indexOf("|"), name = entry.slice(0, bar), all = entry.slice(bar + 1).split(",");
        const std = all.filter((z) => z[0] !== "*"), zips = all.map((z) => z.replace("*", ""));
        cities.set(cityKey(name), { name, zips, std });
        for (const z of zips) if (!zipState.has(z)) zipState.set(z, st);
        if (std.length) { if (!byLen.has(name.length)) byLen.set(name.length, []); byLen.get(name.length).push(name); }
      }
      states.set(st, { cities, byLen });
    }
    PLACES = { states, zipState };
    return PLACES;
  }
  /** A city as the table spells it, from how a document prints it: capitals and spacing do not
   * matter, and St/Ft/Mt are Saint/Fort/Mount. */
  function cityKey(name) {
    return name.toUpperCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim()
      .replace(/^ST\.? /, "SAINT ").replace(/^FT\.? /, "FORT ").replace(/^MT\.? /, "MOUNT ");
  }
  const realCity = (st, name) => { const s = places().states.get(st); return s ? s.cities.get(cityKey(name)) || null : null; };
  /** The longest run of words at the end of `text` that is a real city in `st`, as printed. */
  function cityAtEnd(text, st) {
    const words = text.replace(/[,\s]+$/, "").split(/\s+/).filter(Boolean);
    for (let k = Math.min(4, words.length); k >= 1; k--) {
      const cand = words.slice(-k).join(" ");
      if (/^[A-Za-z]/.test(cand) && realCity(st, cand)) return cand;
    }
    return null;
  }
  // names a firm's clients commonly carry that the stand-in lists do not, for telling gender
  for (const w of "sofia lourdes maria elena ana lucia isabella valeria camila ximena guadalupe rosario carolina mariana fernanda daniela gabriela paola natalia adriana alejandra".split(" ")) FEMALE_SET.add(w);
  for (const w of "luca mateo santiago diego alejandro carlos jose juan luis miguel javier fernando ricardo eduardo andres pablo rafael sergio tomas emilio".split(" ")) MALE_SET.add(w);
  const WORDS = /[\p{L}][\p{L}'’]*/gu;

  // ---------------------------------------------------------------- file profiles
  /** What is kept of a file between finding and swapping: its text, which font draws each
   * stretch of it, what each font can draw, and its lines grouped as they are printed. */
  function profile(model, path) {
    const fonts = [], fontIndex = new Map();
    const fontId = (f) => {
      if (!fontIndex.has(f)) {
        const widths = new Map();
        for (const [ch, code] of f.reverse()) { const w = f.width(code); if (w !== null) widths.set(ch, w); }
        fontIndex.set(f, fonts.length);
        fonts.push({ label: f.label, problem: f.problem, widths });
      }
      return fontIndex.get(f);
    };
    const parts = [];
    for (const part of model.parts) {
      const { text, owner } = E().textOfPart(part);
      if (!text.trim()) continue;
      const runs = [];
      let last = -2;
      for (let j = 0; j < owner.length; j++) {
        const g = owner[j] >= 0 ? part.glyphs[owner[j]] : null;
        const id = g ? fontId(g.font) : -1;
        if (id !== last) { runs.push(j, id); last = id; }
      }
      parts.push({ text, runs, where: part.where, page: part.page });
    }
    const blocks = parts.map((p) => ({ lines: p.text.split("\n"), where: p.where, page: p.page }));
    for (const v of fieldValues(model)) blocks.push({ lines: v.split(/\r\n|\r|\n/), where: "form field value", page: null });
    // a glyph a font gives no letter for reads as U+FFFD; a file of them cannot be searched
    let unreadable = 0, drawn = 0;
    for (const part of model.parts) for (const g of part.glyphs) { if (!g.text.trim()) continue; drawn++; if (g.text.includes("\uFFFD")) unreadable++; }
    return { path, parts, fonts, blocks, glyphs: E().glyphCount(model), unreadable: drawn ? unreadable / drawn : 0 };
  }
  function fieldValues(model) {
    const out = [], P = globalThis.PDFLib, N = (s) => P.PDFName.of(s), ctx = model.ctx;
    const acro = model.doc.catalog.lookup(N("AcroForm"));
    if (!(acro instanceof P.PDFDict)) return out;
    const seen = new Set();
    const deref = (o) => (o instanceof P.PDFRef ? ctx.lookup(o) : o);
    const visit = (node) => {
      node = deref(node);
      if (!(node instanceof P.PDFDict) || seen.has(node)) return; seen.add(node);
      const v = node.lookup(N("V"));
      if ((v instanceof P.PDFString || v instanceof P.PDFHexString) && v.decodeText().trim()) out.push(v.decodeText());
      const kids = node.lookup(N("Kids"));
      if (kids instanceof P.PDFArray) kids.asArray().forEach(visit);
    };
    const fields = acro.lookup(N("Fields"));
    if (fields instanceof P.PDFArray) fields.asArray().forEach(visit);
    return out;
  }
  /** A text file (CSV, TXT): no fonts, so any character can be written in it. */
  function textProfile(text, path) {
    const lines = text.split(/\r\n|\r|\n/);
    const blocks = [{ lines, where: "text", page: null }];
    // a table's SSN column: each value read as "SSN   <value>", so one written as a number
    // without its leading zero ("12345678") is found too. Only for finding; nothing is written
    // from these lines.
    const col = columnLines(lines);
    if (col.length) blocks.push({ lines: col, where: "text", page: null });
    return { path, parts: [{ text, runs: [0, -1], where: "text", page: null }], fonts: [], blocks, glyphs: text.length };
  }
  /** A column headed SSN (or TIN, Social Security Number, SSN/ITIN) in comma- or tab-separated
   * text, its values as labelled lines. The header may sit below a few lines of preamble. */
  const SSN_HEADER = /^\s*(?:ssn|ss ?#|ss ?no\.?|social security(?: number| no\.?| #)?|soc\.? ?sec\.?(?: ?#| no\.?)?|tin|itin|ssn ?\/ ?itin|taxpayer id(?:entification)?(?: number| no\.?)?|tax ?id(?: number| no\.?)?)\s*$/i;
  function splitRow(line, sep) {
    const out = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
      else if (ch === sep && !quoted) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  function columnLines(lines) {
    const out = [];
    for (let h = 0; h < Math.min(lines.length, 30); h++) {
      const sep = lines[h].includes("\t") ? "\t" : ",";
      if (!lines[h].includes(sep)) continue;
      const head = splitRow(lines[h], sep);
      const cols = head.map((c, k) => (SSN_HEADER.test(c) ? k : -1)).filter((k) => k >= 0);
      if (!cols.length) continue;
      for (const line of lines.slice(h + 1)) {
        const cells = splitRow(line, sep);
        for (const k of cols) if (cells[k] && cells[k].trim()) out.push("SSN   " + cells[k].trim());
      }
      break;
    }
    return out;
  }

  // ---------------------------------------------------------------- finding
  function addItem(items, key, kind, display, variant, source, checked) {
    let it = items.get(key);
    if (!it) { it = { key, kind, display, variants: new Set(), sources: new Set(), files: new Set(), checked: !!checked, replacement: null, count: 0, context: "" }; items.set(key, it); }
    if (variant) it.variants.add(variant);
    if (source) it.sources.add(source);
    if (checked) it.checked = true;
    return it;
  }
  const RX = {
    ssn: /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/g,
    ssnSpaced: /(?<![\d ])(\d{3}) (\d{2}) (\d{4})(?![\d ])/g,
    ssnBare: /(?<![\d.,$-])(\d{3})(\d{2})(\d{4})(?![\d,]|\.\d)/g,
    ssnShort: /\b(?:ssn|social security(?: number| no\.?)?|ss ?#|tin|itin|taxpayer id(?: number)?)\b[\s:#.=-]{0,6}(\d{7,8})(?![\d,]|\.\d)/gi,
    masked: /(?<![\w*#•])([*Xx•#]{3})-([*Xx•#]{2})-(\d{4})(?!\d)/g,
    ein: /(?<![\d-])(\d{2})-(\d{7})(?![\d-])/g,
    phone: /(?<![\d(])(?:\((\d{3})\)\s?|(\d{3})[-. ])(\d{3})[-.](\d{4})(?!\d)/g,
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    cityZip: /([A-Za-z][A-Za-z .'-]*?),?\s+([A-Z]{2})\s+(\d{5})(?:-(\d{4}))?(?!\d)/g,
    cityState: new RegExp("([A-Z][A-Za-z.'’-]*(?: [A-Z][A-Za-z.'’-]*){0,3}),\\s*([A-Z]{2}|" + Object.values(STATE_NAMES).join("|") + ")\\b(?!\\s*\\d{5})", "g"),
    // a street is one run of words: never across a gap of three spaces or a tab, which is a
    // table's next cell (a sheet's row is read with its cells three spaces apart)
    street: /(?<![\w-])(\d{1,6}[A-Za-z]?)[ \u00a0]{1,2}((?:[NSEW]|NE|NW|SE|SW|North|South|East|West)\.?[ \u00a0]{1,2})?((?:[A-Za-z0-9'.]*[A-Za-z][A-Za-z0-9'.]*[ \u00a0]{1,2}){0,3}?[A-Za-z0-9'.]*[A-Za-z][A-Za-z0-9'.]*)[ \u00a0]{1,2}(St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace|Trl|Trail|Hwy|Highway|Loop|Sq|Square|Row|Run|Pass|Path|Xing)\.?(?=[\s,#]|$)/gi,
    calle: /(?<![\w-])(\d{1,6})[ \u00a0]{1,2}((?:[NSEW]|North|South|East|West)\.?[ \u00a0]{1,2})?(Calle|Camino|Paseo|Avenida|Via|Vista|Placita|Rancho|Callejon|Circulo|Entrada|Corte)[ \u00a0]{1,2}((?:(?:del|de la|de los|de las|de|la|las|los|el)[ \u00a0]{1,2})?[A-Za-z]+(?:[ \u00a0]{1,2}[A-Za-z]+)?)/gi,
    unit: /\b(Suite|Ste|Apt|Apartment|Unit|Bldg|Building|Rm|Room)\.?\s*#?\s*(\d+[A-Za-z]?)\b/gi,
    pobox: /\bP\.?\s?O\.?\s+Box\s+(\d+)\b/gi,
    dob: /\b(DOB|D\.O\.B\.|date of birth|birth ?date|born)\b[^0-9\n]{0,20}(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/gi,
    // a licence or ID card's number, wherever it is labelled as one ("DL #", "Driver's license
    // number", "4d DLN", "ID No.", "Passport No."); the number has a digit, and spaces or dashes
    // only between runs that have digits too, so "CLASS D" after it is never part of it
    idnum: /\b(?:DLN|D\.?L\.?\s*(?:NO\.?|NUMBER|#)|DL|LIC(?:ENSE)?\.?\s*(?:NO\.?|NUMBER|#)|DRIVER'?S?\s+LICEN[SC]E(?:\s*(?:NO\.?|NUMBER|#))?|(?:STATE\s+)?ID(?:ENTIFICATION)?(?:\s+CARD)?\s*(?:NO\.?|NUMBER|#)|PASSPORT\s*(?:NO\.?|NUMBER|#)|CUSTOMER\s+(?:NO\.?|NUMBER|#))(?![A-Za-z])\s*[:#.]?\s*([A-Z]{0,8}\d[A-Z0-9]*(?:[ -][A-Z0-9]*\d[A-Z0-9]*){0,4})(?![A-Za-z0-9])/gi,
    // on an ID card: the document discriminator ("5 DD 0123..."), a bare "DL" number, the dates
    // it was issued and expires
    idnumCard: /\b(?:DD|DOCUMENT\s+DISCRIMINATOR|AUDIT|INVENTORY|ID|NO\.?)(?![A-Za-z])\s*[:#.]?\s*([A-Z]{0,8}\d[A-Z0-9]*(?:[ -][A-Z0-9]*\d[A-Z0-9]*){0,4})(?![A-Za-z0-9])/gi,
    // any full date on an ID card, its year in four digits (a reader that runs "2021" into the
    // next field's "15" still gives the date)
    cardDate: /(?<!\d)(\d{1,2})[\/.-](\d{1,2})[\/.-]((?:19|20)\d\d)/g,
    // a card number: letters and digits run together, starting with at most three letters
    cardNumber: /(?<![A-Za-z0-9])([A-Z]{0,3}\d[A-Z0-9]{6,23})(?![A-Za-z0-9])/g,
    iddate: /\b(?:EXP(?:IRES|IRATION(?:\s+DATE)?)?|ISS(?:UED|UE\s+DATE)?|VALID\s+(?:FROM|THRU|THROUGH|UNTIL))(?![A-Za-z])[^0-9\n]{0,8}(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/gi,
  };
  const ADDRESS_LINE = new RegExp("(?:" + RX.street.source + ")|(?:" + RX.calle.source + ")|\\bP\\.?\\s?O\\.?\\s+Box\\s+\\d", "i");
  const WORDISH = new Set(["name", "business"]); // swapped word by word, inside phrases where risky
  const STATE_CODE = new Map(Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]));
  const titleWords = (s) => s.split(/(\s+|-)/).map((w) => (/^[A-Za-z]/.test(w) && (w === w.toUpperCase() || w === w.toLowerCase()) ? title(w) : w)).join("");
  const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);
  const GENERIC_EMAIL = /^(info|support|help|noreply|no-reply|service|services|contact|admin|billing|tax|taxes|office|hello|team|sales|statements)$/i;

  /** The name words of a line that reads as people's names, each with its likely role
   * (first, middle, last), or null. "Last, First & Second" and "First Middle Last" both read. */
  function nameTokens(text, { strict }) {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned || /\d/.test(cleaned) || cleaned.length > 90 || INSTITUTION.test(cleaned)) return null;
    let names = 0, other = 0, label = false;
    for (const w of cleaned.match(WORDS) || []) {
      if (w.length === 1 || /^and$/i.test(w)) continue;
      if (LABEL_WORDS.has(stem(w))) label = true;
      if (isNameWord(w) && /^\p{Lu}/u.test(w)) names++; else other++;
    }
    if (!names || label) return null;
    if (strict ? names < 2 || other > 0 : other > names) return null;
    const out = [];
    const person = (seg, lastFirst) => {
      // a hyphenated last word is a double surname: every part of it is a surname
      const words = (seg.match(/[\p{L}][\p{L}'’-]*/gu) || []).filter((w) => w.length > 1);
      const named = [];
      words.forEach((w, i) => w.split(/[-–]/).forEach((part) => named.push({ part, last: i === words.length - 1 && words.length > 1, first: i === 0 })));
      const kept = named.filter((n) => n.part.length > 1 && isNameWord(n.part) && /^\p{Lu}/u.test(n.part));
      kept.forEach((n) => out.push({ t: n.part, role: lastFirst || n.last ? "last" : kept.length === 1 || n.first ? "first" : "middle" }));
    };
    const comma = /^([^,&]+),\s*(.+)$/.exec(cleaned);
    if (comma) {
      person(comma[1], true);
      for (const seg of comma[2].split(/\s*(?:&|\band\b)\s*/i)) {
        const words = (seg.match(WORDS) || []).filter((w) => w.length > 1 && isNameWord(w));
        words.forEach((w, i) => out.push({ t: w, role: i === 0 ? "first" : "middle" }));
      }
    } else {
      const segs = cleaned.split(/\s*(?:&|\band\b)\s*/i);
      segs.forEach((seg) => person(seg, false));
    }
    return out.length ? out : null;
  }

  /** A client folder's name read as people's names: "Last, First", or two or more name words, or
   * one word that is on the name lists. "Private" or "Archive" is a folder, not a client. */
  function folderName(name) {
    const cleaned = name.replace(/_+/g, " ").replace(/\b(19|20)\d{2}\b/g, " ").replace(/[()[\]]/g, " ").replace(/\s+/g, " ").trim();
    const toks = nameTokens(cleaned, { strict: false });
    if (!toks) return null;
    if (toks.length < 2 && !/,/.test(cleaned) && !inLists(toks[0].t)) return null;
    return toks;
  }

  /** The name words of a line that reads as a person's name, judged on evidence. One word at
   * least must be a known name: a word of a client folder's name, or a first name or surname on
   * the lists that is not also an everyday word in this folder. No word may be lowercase (but
   * "de", "van" and the like), an everyday word of this folder, a state code or a short acronym.
   * A form's own words ("Self-Employed", "Identity Protection", "Relationship") fail all three. */
  function personPhrase(text, ev, strict) {
    // "Owner: Marisol Quill" is the name after the label
    let t = text.replace(/\s+/g, " ").trim().replace(/^[^:]{1,40}:\s*/, "").replace(HONORIFIC, "");
    for (let prev = ""; prev !== t;) { prev = t; t = t.replace(CREDENTIAL, ""); }
    if (!t || INSTITUTION.test(t) || new RegExp(BUSINESS.source).test(t + " ")) return null;
    for (const w of t.match(WORDS) || []) if (/^\p{Ll}/u.test(w) && !PARTICLES.has(w) && w !== "and") return null;
    const toks = nameTokens(t, { strict });
    if (!toks) return null;
    const kept = toks.filter(({ t: w }) => ev.known(w) || ev.plausible(w));
    return kept.some(({ t: w }) => ev.known(w)) ? kept : null;
  }
  /** After a label that names a person ("Spouse:", "Taxpayer:", "Dependent 2"), two to four
   * capitalized words that could be names are the person's name, though no table holds them
   * ("Dmitri Vance": a first name the tables lack, a surname that is also a word): the label is
   * the evidence the tables would otherwise be. */
  const PERSON_LABEL = /\b(?:taxpayer|spouse|recipient|student|borrower|employee|account holder|beneficiary|participant|insured|patient|client|dependent|child|son|daughter|qualifying (?:child|person|relative))\b/i;
  const NEXT_FIELD = /\s+(?=(?:SSN|SS#|TIN|ITIN|EIN|DOB|D\.O\.B\.?|ID|Phone|Tel|Telephone|E-?mail|Address|Acct|Account|Date|Age|Relationship)\b|\S*\d)/i;
  function labelledPerson(text, ev) {
    const t = text.replace(/\s+/g, " ").trim().replace(HONORIFIC, "");
    if (!t || INSTITUTION.test(t) || new RegExp(BUSINESS.source).test(t + " ")) return null;
    const words = (t.match(WORDS) || []).filter((w) => w.length > 1);
    if (words.length < 2 || words.length > 4 || words.some((w) => !/^\p{Lu}/u.test(w) || !isNameWord(w) || !ev.plausible(w))) return null;
    const toks = nameTokens(t, { strict: true });
    return toks && toks.every(({ t: w }) => ev.plausible(w)) ? toks : null;
  }
  /** First names beside the family's surname in running text: each adjacent pair "First
   * Surname", or "First M Surname" and "First M. Surname", where the surname is a word the client
   * folder's name gives as a surname and the first word is a plausible name, not a label, an
   * honorific or an everyday word of this folder. Pairs may overlap ("Call Bram Halvorsen"). */
  function familyNames(line, ev) {
    if (!ev.family.size) return [];
    const caps = [...line.matchAll(/(?<![\p{L}'’])(\p{Lu}[\p{L}'’-]*)(\.?)/gu)].map((m) => ({ w: m[1], dot: m[2], at: m.index, end: m.index + m[0].length }));
    const out = [];
    const gap = (a, b) => /^\s+$/.test(line.slice(a.end, b.at));
    for (let i = 0; i < caps.length; i++) {
      const first = caps[i];
      if (first.w.length < 2 || first.dot || ev.family.has(first.w.toLowerCase()) || HONORIFIC.test(first.w + " ")) continue;
      if (!ev.plausible(first.w) || !isNameWord(first.w) || INSTITUTION.test(first.w)) continue;
      let j = i + 1, mid = null;
      if (caps[j] && caps[j].w.length === 1 && gap(first, caps[j])) { mid = caps[j]; j++; }
      const last = caps[j];
      if (!last || !gap(mid || first, last) || !ev.family.has(last.w.toLowerCase())) continue;
      const toks = [{ t: first.w, role: "first" }].concat(mid ? [{ t: mid.w, role: "middle" }] : [], [{ t: last.w, role: "last" }]);
      out.push({ text: line.slice(first.at, last.end), toks });
    }
    return out;
  }
  /** A business named on a payer's or employer's line, without LLC or Inc: the line after
   * "Employer's name, address" (or a payer's, filer's, lender's), or the rest of "Employer: ...",
   * up to its first comma. Not a bank, a school or an agency (they name no one), never a line with
   * a number in it (an address). */
  const PAYER_LABEL = /\b(?:employer|payer|filer|lender|trustee|issuer|creditor|company)(?:'s|’s|'S)?\s+name\b/i;
  const PAYER_INLINE = /^\s*(?:employer|payer|company|business)(?: name)?\s*:\s*(.+)$/i;
  function payerLine(line, prevLine) {
    const inline = PAYER_INLINE.exec(line);
    const text = inline ? inline[1] : prevLine && PAYER_LABEL.test(prevLine) && !PAYER_LABEL.test(line) ? line : null;
    if (!text) return null;
    const name = text.split(/,|\s{3,}|\t/)[0].trim();
    if (!name || /\d/.test(name) || INSTITUTION.test(name) || new RegExp(BUSINESS.source).test(name + " ")) return null;
    const words = name.split(/\s+/);
    if (words.length > 6 || !words.every((w) => /^[A-Z&+]/.test(w) || /^(?:and|of|the)$/.test(w))) return null;
    return name;
  }
  /** What a folder's own text says about its words: which are everyday words (written in
   * lowercase somewhere), and so which are evidence of a name. */
  function evidence(profiles, clientFolders) {
    const everyday = new Set(), folder = new Set(), family = new Set();
    for (const prof of profiles) for (const block of prof.blocks) for (const line of block.lines) {
      // a web address in small letters ("acmeplumbing.com") is a name written small, not an everyday word
      const plain = line.replace(RX.email, " ").replace(/\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(?:com|net|org|us|co|io|biz|info|gov|edu)\b/gi, " ");
      for (const m of plain.matchAll(/(?<![\p{L}'’])\p{Ll}[\p{Ll}'’]{2,}(?!\p{L})/gu)) everyday.add(m[0].replace(/['’]s$/, ""));
    }
    for (const { name } of clientFolders) for (const { t, role } of folderName(name) || []) { folder.add(t.toLowerCase()); if (role === "last") family.add(t.toLowerCase()); }
    const known = (w) => { const l = w.toLowerCase(); return folder.has(l) || (inLists(w) && !ALSO_A_WORD.has(l) && !everyday.has(l)); };
    const plausible = (w) => {
      const l = w.toLowerCase(), upper = w === w.toUpperCase();
      if (w.length < 2 || everyday.has(l) || NOT_NAME.has(stem(w)) || LABEL_WORDS.has(stem(w))) return false;
      if (upper && w.length === 2 && STATES.has(w) && !folder.has(l)) return false;
      if (upper && w.length <= 3 && !inLists(w) && !folder.has(l)) return false;
      return true;
    };
    return { everyday, folder, family, known, plausible };
  }

  const ACCOUNT = /\b(?:account|acct)\.?\s*(?:number|no\.?|#)?\s*[:#]?\s+([A-Z0-9][A-Z0-9-]{3,})\b/i;
  const ACCOUNT_LABEL = /\b(?:account|acct)\.?\s*(?:number|no\.?|#)\s*:?\s*$/i;
  const ACCOUNT_VALUE = /^\s*([A-Z0-9][A-Z0-9-]{3,})\s*$/i;
  function detectInText(items, text, file, source, prev, prevLine, idCard = false) {
    const personal = !INSTITUTION.test(prev || "");
    // a licence or ID number: shaped like one (5 to 24 letters and digits, mostly digits or a
    // letter then digits), never a date
    const idNumber = (v) => {
      const bare = v.replace(/[ -]/g, "");
      return bare.length >= 5 && bare.length <= 24 && (bare.match(/\d/g) || []).length >= 4 && !/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(v);
    };
    for (const rx of idCard ? [RX.idnum, RX.idnumCard] : [RX.idnum]) for (const mm of text.matchAll(rx)) {
      const v = mm[1].trim();
      if (idNumber(v) && !/^\d{3}-\d{2}-\d{4}$|^\d{2}-\d{7}$/.test(v)) addItem(items, "idnum:" + v.toUpperCase(), "idnum", v, v, source, true).files.add(file);
    }
    if (idCard || /\b(?:licen[sc]e|identification|passport|ID card)\b/i.test(text + " " + (prev || ""))) for (const mm of text.matchAll(RX.iddate)) addItem(items, "iddate:" + mm[1], "iddate", mm[1], mm[1], source, true).files.add(file);
    // on an ID card nothing printed as a date or a long number is anybody else's: the reader
    // often loses a small label ("4b EXP" read as "sais"), so every full date is a birthday when
    // it is far enough back to be one and the card's own date otherwise, and every run of letters
    // and digits with seven digits or more is a card number
    if (idCard) {
      const labelled = new Set([...text.matchAll(RX.dob)].map((mm) => mm[2]).concat([...text.matchAll(RX.iddate)].map((mm) => mm[1])));
      const now = new Date().getUTCFullYear();
      for (const mm of text.matchAll(RX.cardDate)) {
        const v = mm[0];
        if (labelled.has(v) || items.has("dob:" + v) || items.has("iddate:" + v) || +mm[1] < 1 || +mm[1] > 12 || +mm[2] < 1 || +mm[2] > 31) continue;
        const age = now - +mm[3];
        if (age >= 14 && age <= 110) addItem(items, "dob:" + v, "dob", v, v, source, true).files.add(file);
        else addItem(items, "iddate:" + v, "iddate", v, v, source, true).files.add(file);
      }
      for (const mm of text.matchAll(RX.cardNumber)) {
        const v = mm[1];
        if ((v.match(/\d/g) || []).length >= 7 && !items.has("idnum:" + v.toUpperCase()) && !items.has("ssn:" + v)) addItem(items, "idnum:" + v.toUpperCase(), "idnum", v, v, source, true).files.add(file);
      }
    }
    let m;
    for (m of text.matchAll(RX.ssn)) {
      if (+m[1] === 0 || +m[1] === 666 || +m[2] === 0 || +m[3] === 0) continue;
      addItem(items, "ssn:" + m[1] + m[2] + m[3], "ssn", m[0], m[0], source, true).files.add(file);
    }
    if (/\b(ssn|tin|social security|taxpayer id)/i.test(text)) for (m of text.matchAll(RX.ssnSpaced)) addItem(items, "ssn:" + m[1] + m[2] + m[3], "ssn", m[1] + "-" + m[2] + "-" + m[3], m[0], source, true).files.add(file);
    // seven or eight digits right after an SSN label: a spreadsheet or a CSV that kept the SSN as
    // a number dropped its leading zeros (012-34-5678 is 12345678)
    for (m of text.matchAll(RX.ssnShort)) {
      const d = m[1].padStart(9, "0");
      if (+d.slice(0, 3) === 0 || +d.slice(3, 5) === 0 || +d.slice(5) === 0) continue;
      addItem(items, "ssn:" + d, "ssn", d.slice(0, 3) + "-" + d.slice(3, 5) + "-" + d.slice(5), m[1], source, true).files.add(file);
    }
    // nine digits with no dashes, on a line that says SSN or TIN (a spreadsheet keeps the number)
    if (/\b(ssn|social security|taxpayer id|tin|itin)\b/i.test(text)) for (m of text.matchAll(RX.ssnBare)) {
      if (+m[1] === 0 || +m[1] === 666 || +m[2] === 0 || +m[3] === 0) continue;
      addItem(items, "ssn:" + m[1] + m[2] + m[3], "ssn", m[1] + "-" + m[2] + "-" + m[3], m[0], source, true).files.add(file);
    }
    for (m of text.matchAll(RX.masked)) addItem(items, "ssn4:" + m[0], "ssn4", m[0], m[0], source, true).files.add(file);
    for (m of text.matchAll(RX.ein)) addItem(items, "ein:" + m[1] + m[2], "ein", m[0], m[0], source, true).files.add(file);
    for (m of text.matchAll(RX.phone)) {
      const area = m[1] || m[2];
      if (/1[-\s.]\s*$/.test(text.slice(0, m.index))) continue;
      addItem(items, "phone:" + area + m[3] + m[4], "phone", m[0], m[0], source, !TOLL_FREE.has(area)).files.add(file);
    }
    for (m of text.matchAll(RX.email)) addItem(items, "email:" + m[0].toLowerCase(), "email", m[0], m[0], source, !GENERIC_EMAIL.test(m[0].split("@")[0])).files.add(file);
    // City, ST 12345: an address when the ZIP is a real ZIP of that state or the words before the
    // state code end in a real city there; the city is that longest real run of words
    const addCity = (printed, st) => {
      const it = addItem(items, "city:" + st + ":" + cityKey(printed), "city", titleWords(printed), printed, source, personal);
      it.state = st; it.files.add(file);
      addItem(items, "state:" + st, "state", st, st, source, false).files.add(file);
      return it;
    };
    for (m of text.matchAll(RX.cityZip)) {
      const st = m[2];
      if (!STATES.has(st)) continue;
      const printed = cityAtEnd(m[1], st), zipReal = places().zipState.get(m[3]) === st;
      if (!printed && !zipReal) continue;
      const city = printed ? addCity(printed, st) : null;
      const zip = addItem(items, "zip:" + m[3], "zip", m[3], m[3], source, personal);
      zip.files.add(file); zip.state = zip.state || st;
      if (city && !zip.city) zip.city = city.key;
      if (m[4]) addItem(items, "zip4:" + m[3] + m[4], "zip4", m[3] + "-" + m[4], m[3] + "-" + m[4], source, personal).files.add(file);
    }
    // City, ST or City, State with no ZIP after it: only a real city counts
    for (m of text.matchAll(RX.cityState)) {
      const st = m[2].length === 2 ? m[2] : STATE_CODE.get(m[2].toLowerCase());
      if (!st || !STATES.has(st)) continue;
      const printed = cityAtEnd(m[1], st);
      if (printed) addCity(printed, st);
    }
    // a street is capitalized words between its number and its kind; "line 14 from ln 15" and
    // "43 When did you place it" are instructions, not streets
    const capital = (words) => words.every((w) => /^[A-Z0-9#]/.test(w) || /^(?:de|del|la|las|los|el)$/.test(w));
    const englishAt = [];
    for (m of text.matchAll(RX.street)) {
      const s = m[0].trim();
      if (!capital(s.split(/\s+/).slice(1))) continue;
      englishAt.push([m.index, m.index + m[0].length]);
      addItem(items, "street:" + s.toUpperCase(), "street", s, s, source, personal).files.add(file);
    }
    for (m of text.matchAll(RX.calle)) {
      const s = m[0].trim();
      // "2054 VISTA PARKWAY" is an English street that starts with a Spanish word
      if (englishAt.some(([a, b]) => m.index < b && a < m.index + m[0].length) || !capital(s.split(/\s+/).slice(1))) continue;
      addItem(items, "street:" + s.toUpperCase(), "street", s, s, source, personal).files.add(file);
    }
    for (const rx of [RX.unit, RX.pobox]) for (m of text.matchAll(rx)) addItem(items, "unit:" + m[0].toUpperCase(), "unit", m[0], m[0], source, personal).files.add(file);
    const acct = ACCOUNT.exec(text) || (ACCOUNT_LABEL.test(prevLine || "") ? ACCOUNT_VALUE.exec(text) : null);
    if (acct) { const v = acct[acct.length - 1]; if (/\d{3}/.test(v) && !/^\d{3}-\d{2}-\d{4}$|^\d{2}-\d{7}$/.test(v)) addItem(items, "acct:" + v, "acct", v, v, source, true).files.add(file); }
    for (m of text.matchAll(RX.dob)) addItem(items, "dob:" + m[2], "dob", m[2], m[2], source, true).files.add(file);
  }

  /** Finds everything, over every file's page text, form values, and the client folder names. */
  function detect(profiles, { clientFolders = [] } = {}) {
    const items = new Map(), phrases = new Map(), nameLines = new Set();
    const ev = evidence(profiles, clientFolders);
    const addPhrase = (text, toks, file, source, lineKey, kind = "name") => {
      if (lineKey) nameLines.add(lineKey);
      // a name starts and ends with a letter or a figure (an initial may keep its full stop): what
      // the reader made of a mark beside it ("> QUENBY ODETTE" for "2 QUENBY ODETTE") is not part
      // of it
      const key = text.trim().replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}.)]+$/u, "");
      if (!key) return;
      if (!phrases.has(key)) phrases.set(key, { files: new Set(), source });
      phrases.get(key).files.add(file);
      for (const { t, role, lead } of toks) {
        // a word already found as a person's name stays one; a business word is the business's
        if (kind === "business" && items.has("name:" + t.toUpperCase())) continue;
        const it = addItem(items, kind + ":" + t.toUpperCase(), kind, title(t), t, source, true);
        it.files.add(file);
        (it.roles = it.roles || new Set()).add(role);
        (it.roleCount = it.roleCount || new Map()).set(role, (it.roleCount.get(role) || 0) + 1);
        // the first word of a business's own name is the one that names it; the words after it
        // ("Survey", "Copper") are often everyday words, and are swapped only inside the name
        if (lead) it.lead = true;
        // "Last, First M" on a client's folder is the firm's own word for which name is which
        if (source === "client folder name") (it.folderRoles = it.folderRoles || new Set()).add(role);
        if (!it.context) it.context = key;
      }
      // a middle initial: one capital letter right after a word of the name ("Corwin D", "Ann K.")
      if (kind === "name") {
        const words = new Set(toks.map(({ t }) => t.toLowerCase()));
        for (const m of key.matchAll(/(?<![\p{L}'’])(\p{L}[\p{L}'’-]+)\s+(\p{Lu})(?![\p{L}'’])/gu)) {
          if (!words.has(m[1].toLowerCase())) continue;
          const it = addItem(items, "name:" + m[2], "name", m[2], m[2], source, true);
          it.files.add(file); it.initial = true;
          (it.roles = it.roles || new Set()).add("middle");
          if (!it.context) it.context = key;
        }
      }
    };
    for (const { name, files } of clientFolders) {
      const toks = folderName(name);
      if (toks) for (const f of files) addPhrase(name, toks, f, "client folder name", null);
    }
    profiles.forEach((prof, pi) => {
      const file = prof.path;
      prof.blocks.forEach((block, bi) => {
        block.lines.forEach((line, li) => {
          const lineKey = pi + ":" + bi + ":" + li;
          detectInText(items, line, file, block.where, block.lines.slice(Math.max(0, li - 3), li).join(" "), block.lines[li - 1], !!block.idCard);
          // an ID card's name lines, numbered as the card standard numbers them: "1" the family
          // name, "2" the given names (with "LN" and "FN" the way some states print them)
          if (block.idCard) {
            const nm = /^\s*(?:(1|LN)|(2|FN))\s+([A-Z][A-Za-z'’ -]{1,40})\s*$/.exec(line);
            if (nm) {
              const words = nm[3].trim().split(/\s+/).filter((w) => w.length > 1 && isNameWord(w));
              if (words.length) addPhrase(nm[3].trim(), words.map((t, k) => ({ t, role: nm[1] ? "last" : k === 0 ? "first" : "middle" })), file, "an ID card's name line", lineKey);
            }
          }
          const lab = LABEL.exec(line);
          if (lab) {
            // the name runs to where the line goes on to something else: a wide gap or a tab, and
            // where a reader read the gap as one space, a number or the next label ("Spouse:
            // Dmitri Okonkwo SSN 529-61-0447")
            const rest = lab[1].split(/\s{3,}|\t/)[0].split(NEXT_FIELD)[0];
            const toks = personPhrase(rest, ev, false) || (PERSON_LABEL.test(lab[0].slice(0, lab[0].length - lab[1].length)) ? labelledPerson(rest, ev) : null);
            if (toks) addPhrase(rest, toks, file, "labelled line", lineKey);
          }
          // "Preparer's name" or "RECIPIENT'S name" at the end of a line: the name is the next line
          if (li > 0 && /\bname\s*:?\s*$/i.test(block.lines[li - 1])) {
            const toks = personPhrase(line, ev, false);
            if (toks) addPhrase(line, toks, file, "line after a name label", lineKey);
          }
          // a first name written beside the family's surname anywhere in a sentence ("we have
          // Juniper Halvorsen and Oskar Halvorsen as dependents"): the folder says which word is
          // the surname, so the word before it is a first name, and a letter between them an initial
          for (const fam of familyNames(line, ev)) addPhrase(fam.text, fam.toks, file, "a name beside the family's surname", lineKey);
          // an employer or payer named without LLC or Inc: on the line after "Employer's name",
          // or after "Employer:"; up to the first comma, so its address stays an address
          const payer = payerLine(line, block.lines[li - 1]);
          if (payer) {
            const own = (payer.match(/[A-Za-z][A-Za-z0-9'’]*/g) || []).filter((w) => w.length > 1 && /^[A-Z]/.test(w)
              && !GENERIC_BUSINESS.has(w.toLowerCase()) && !NOT_NAME.has(stem(w)) && !LABEL_WORDS.has(stem(w)) && !(w.length === 2 && STATES.has(w)));
            // a word of a business's kind ("Group", "Services") makes it one, whatever its name is;
            // otherwise a payer that reads as a person (a household employer) is a person
            const kindWord = (payer.match(/[A-Za-z]+/g) || []).some((w) => GENERIC_BUSINESS.has(w.toLowerCase()));
            const person = kindWord ? null : personPhrase(payer, ev, false);
            if (person) addPhrase(payer, person, file, "employer or payer", lineKey);
            else if (own.length) addPhrase(payer, own.map((t, k) => ({ t, role: "business", lead: k === 0 })), file, "employer or payer", lineKey, "business");
          }
          // a short line of names holding a word of a client folder's name: a dependent beside the
          // family name, a former surname beside the first name
          const ws = line.match(WORDS) || [];
          if (ws.length <= 6 && ws.some((w) => ev.folder.has(w.toLowerCase()))) {
            const toks = personPhrase(line, ev, false);
            if (toks) addPhrase(line, toks, file, "a line with the client's name", lineKey);
          }
          if (ADDRESS_LINE.test(line)) {
            for (let k = li - 1; k >= Math.max(0, li - 3); k--) {
              const above = block.lines[k];
              if (INSTITUTION.test(above)) break;
              const toks = personPhrase(above, ev, false);
              if (!toks) break;
              addPhrase(above, toks, file, "name above an address", pi + ":" + bi + ":" + k);
            }
          }
          if (block.where === "form field value" && block.lines.length === 1) {
            const toks = personPhrase(line, ev, true);
            if (toks) addPhrase(line, toks, file, "form field", lineKey);
          }
          // a business: its own words before LLC, Inc and the like; what kind of business it is
          // ("Consulting", "Services") and its legal form stay as printed
          for (const bm of line.matchAll(BUSINESS)) {
            const phrase = bm[0].trim();
            if (INSTITUTION.test(phrase)) continue;
            const own = (bm[1].match(/[A-Za-z][A-Za-z0-9'’]*/g) || []).filter((w) => w.length > 1 && /^[A-Z]/.test(w)
              && !GENERIC_BUSINESS.has(w.toLowerCase()) && !NOT_NAME.has(stem(w)) && !LABEL_WORDS.has(stem(w)) && !(w.length === 2 && STATES.has(w)));
            if (own.length) addPhrase(phrase, own.map((t, k) => ({ t, role: "business", lead: k === 0 })), file, "business name", lineKey, "business");
          }
        });
      });
    });
    // a relation written beside a first name on a short line ("Juniper Halvorsen, Daughter",
    // "Son: Oskar") says which list its stand-in comes from when the lists do not know the name
    const HER = /\b(?:daughter|wife|mother|sister|niece|granddaughter|stepdaughter|mrs|ms|miss)\b/i, HIM = /\b(?:son|husband|father|brother|nephew|grandson|stepson|mr)\b/i;
    profiles.forEach((prof) => prof.blocks.forEach((block) => block.lines.forEach((line) => {
      const her = HER.test(line), him = HIM.test(line);
      if (her === him || (line.match(WORDS) || []).length > 10) return;
      for (const w of line.match(WORDS) || []) {
        const it = items.get("name:" + w.toUpperCase());
        if (it && it.roles && (it.roles.has("first") || it.roles.has("middle"))) it.gender = (it.gender || 0) + (her ? 1 : -1);
      }
    })));
    // Each printed form of a name (Price, PRICE, price) is judged on its own: a form that also
    // appears outside any name (a "Sale Price" heading, the state code MO) is swapped only inside
    // the names it was found in.
    const forms = new Map(); // exact form -> item
    for (const it of items.values()) if (WORDISH.has(it.kind)) {
      it.forms = new Map();
      for (const f of new Set([...it.variants, it.display, it.display.toUpperCase(), it.display.toLowerCase()])) { it.forms.set(f, { inside: 0, outside: 0 }); forms.set(f, it); }
    }
    profiles.forEach((prof, pi) => prof.blocks.forEach((block, bi) => block.lines.forEach((line, li) => {
      const words = [...line.matchAll(WORDS)].map((m) => m[0]);
      if (!words.some((w) => forms.has(w))) return;
      const isNameLine = nameLines.has(pi + ":" + bi + ":" + li);
      const real = words.filter((w) => w.length > 1 && !/^and$/i.test(w));
      real.forEach((w, k) => {
        const it = forms.get(w);
        if (!it) return;
        const near = [real[k - 1], real[k + 1]].some((n) => n && forms.has(n) && forms.get(n) !== it);
        const stat = it.forms.get(w);
        if (isNameLine || near) stat.inside++; else stat.outside++;
      });
    })));
    for (const it of items.values()) if (WORDISH.has(it.kind)) {
      // swapped everywhere unless it is also an everyday word (or two letters, or a state code)
      // and the folder really does use it outside a name
      const risky = (f) => ALSO_A_WORD.has(f.toLowerCase()) || ev.everyday.has(f.toLowerCase()) || f.length <= 2 || (f.length <= 3 && STATES.has(f));
      const outsideForms = [...it.forms].filter(([f, s]) => (s.outside > 0 && risky(f))
        // a business's words in small letters are everyday words; only its first word, capitalized,
        // is taken to name it outside the name (in a file name, on a line of its own)
        || (it.kind === "business" && (f === f.toLowerCase() || !it.lead))
        // an initial ("R") is a letter anywhere else
        || f.length === 1 || it.initial).map(([f]) => f);
      it.phraseOnly = new Set(outsideForms);
      it.mode = !outsideForms.length ? "everywhere" : outsideForms.length === it.forms.size ? "inside names only" : "inside names only, for some capitals";
    }
    for (const it of items.values()) if (it.kind === "city") {
      const l = it.display.toLowerCase();
      it.risky = ev.everyday.has(l) || ALSO_A_WORD.has(l) || inLists(it.display) || items.has("name:" + it.display.toUpperCase());
    }
    const lastFours = new Map([...items.values()].filter((o) => o.kind === "ssn").map((o) => [o.key.slice(-4), o]));
    if (lastFours.size) profiles.forEach((prof) => prof.blocks.forEach((block) => block.lines.forEach((line) => {
      for (const m of line.matchAll(/(?<![\w-])([A-Z0-9]+(?:-[A-Z0-9]+)*)-(\d{4})(?![\w-])/g)) {
        const full = lastFours.get(m[2]);
        if (!full || /^\d{3}-\d{2}$/.test(m[1]) || /^[*Xx•#]+(-[*Xx•#]+)*$/.test(m[1])) continue;
        const it = addItem(items, "acct:" + m[0], "acct", m[0], m[0], block.where, true);
        it.files.add(prof.path); it.linked = full.key;
      }
    })));
    for (const it of items.values()) if (it.kind === "ssn4") {
      const last4 = it.display.slice(-4);
      const full = [...items.values()].find((o) => o.kind === "ssn" && o.key.endsWith(last4));
      if (full) it.linked = full.key;
    }
    // a business's name as the folder prints it inside a web address, whatever the address ends
    // in ("acmeplumbing.shop" on a card statement's payee line): each one printed is kept with the
    // business, so its row is the address as printed and not a guess at every ending there is
    const leads = new Map([...items.values()].filter((o) => o.kind === "business" && o.lead).map((o) => [o.display.toLowerCase(), o]));
    if (leads.size) profiles.forEach((prof) => prof.blocks.forEach((block) => block.lines.forEach((line) => {
      for (const m of line.matchAll(/(?<![\w.@-])(?:www\.)?([A-Za-z0-9-]+)\.([A-Za-z]{2,12})(?![\w-])/g)) {
        const it = leads.get(m[1].toLowerCase());
        if (it) (it.domains = it.domains || new Set()).add(m[2].toLowerCase());
      }
    })));
    return { items, phrases };
  }

  // ---------------------------------------------------------------- the forms a value is printed in
  function fromDigits(form, digits) { let k = 0; return form.replace(/\d/g, () => digits[k++] ?? "0"); }
  /** find -> replace for every form an item can be printed in, given a stand-in. */
  function formsFor(it, rep, all = true) {
    const out = new Map();
    const add = (f, r) => { if (f && r && (all || f !== r)) out.set(f, r); };
    switch (it.kind) {
      case "name": case "business": for (const f of it.forms ? it.forms.keys() : [it.display, it.display.toUpperCase()]) add(f, copyCase(f, rep)); break;
      case "city": for (const f of new Set([...it.variants, it.display, it.display.toUpperCase()])) add(f, copyCase(f, rep)); break;
      case "state": add(it.display, rep); break;
      case "ssn": {
        const d = it.display.replace(/\D/g, ""), r = rep.replace(/\D/g, "");
        add(d.slice(0, 3) + "-" + d.slice(3, 5) + "-" + d.slice(5), r.slice(0, 3) + "-" + r.slice(3, 5) + "-" + r.slice(5));
        add(d.slice(0, 3) + " " + d.slice(3, 5) + " " + d.slice(5), r.slice(0, 3) + " " + r.slice(3, 5) + " " + r.slice(5));
        add(d, r);
        // a number keeps no leading zero: 012-34-5678 is 12345678 in a spreadsheet's cell, and the
        // stand-in has as many leading zeros, so it is printed with as many digits
        const z = d.match(/^0*/)[0].length;
        if (z && z < 9 && r.match(/^0*/)[0].length === z) add(d.slice(z), r.slice(z));
        break;
      }
      case "ein": { const d = it.display.replace(/\D/g, ""), r = rep.replace(/\D/g, ""); add(it.display, rep); add(d, r); break; }
      case "phone": {
        const d = it.display.replace(/\D/g, ""), r = rep.replace(/\D/g, "");
        const fmts = [(x) => "(" + x.slice(0, 3) + ") " + x.slice(3, 6) + "-" + x.slice(6), (x) => "(" + x.slice(0, 3) + ")" + x.slice(3, 6) + "-" + x.slice(6), (x) => x.slice(0, 3) + "-" + x.slice(3, 6) + "-" + x.slice(6), (x) => x.slice(0, 3) + "." + x.slice(3, 6) + "." + x.slice(6)];
        for (const fmt of fmts) add(fmt(d), fmt(r));
        for (const v of it.variants) add(v, fromDigits(v, r));
        break;
      }
      case "street": case "unit": case "email": for (const f of new Set([...it.variants, it.display, it.display.toUpperCase()])) add(f, copyCase(f, rep)); break;
      case "custom": case "acct": case "dob": case "iddate": add(it.display, rep); break;
      case "idnum": {
        // the number as printed, and run together (a form keeps it without its spaces or dashes)
        add(it.display, rep);
        const bare = it.display.replace(/[ -]/g, ""), rb = rep.replace(/[ -]/g, "");
        if (bare.length === it.display.length || bare.length === rb.length) add(bare, rb);
        break;
      }
      default: for (const f of new Set([...it.variants, it.display])) add(f, fromDigits(f, rep.replace(/\D/g, "")));
    }
    return out;
  }

  /** Where each item is printed, as (font, form): what a stand-in has to be written in. A form
   * value, a text file or a file name has no font, so anything fits there. */
  function attachContexts(items, profiles) {
    const rows = [];
    for (const it of items.values()) {
      it.ctx = new Map(); it.count = 0;
      for (const f of formsFor(it, it.display).keys()) rows.push({ id: rows.length, find: f, replace: f, item: it });
    }
    const prepared = E().prepareRows(rows);
    for (const prof of profiles) for (const part of prof.parts) {
      for (const [s, e, row] of E().findMatches(part.text, prepared)) {
        row.item.count++;
        const seen = new Set();
        for (let j = s; j < e; j++) {
          const fi = fontAt(part.runs, j);
          if (fi < 0 || seen.has(fi)) continue;
          seen.add(fi);
          const key = prof.path + "#" + fi + "#" + row.find;
          if (!row.item.ctx.has(key)) row.item.ctx.set(key, { font: prof.fonts[fi], form: row.find });
        }
      }
    }
  }
  function fontAt(runs, j) { let id = -1; for (let k = 0; k < runs.length; k += 2) { if (runs[k] > j) break; id = runs[k + 1]; } return id; }

  /** How well a stand-in fits everywhere the item is printed: null when some font that prints
   * it does not carry a character it needs, otherwise the worst width change (wider counts
   * double, because narrower only leaves a little more space and wider can touch the next word). */
  function fit(it, rep) {
    if (!rep) return null;
    const map = formsFor(it, rep);
    let worst = 0;
    for (const { font, form } of (it.ctx || new Map()).values()) {
      if (font.problem) continue;
      const neu = map.get(form);
      if (!neu) continue;
      let ow = 0, nw = 0;
      // the old value's width against the new one's, whatever their lengths (the spacing takes up
      // a small difference); a scanned page's stand-in font can draw any letter, and one it has
      // no width for counts as an average letter of the old value
      for (const ch of form) ow += font.widths.get(ch) || 0;
      const avg = form.length ? ow / form.length : 500;
      for (const ch of neu) {
        const n = font.widths.get(ch);
        if (n === undefined && !form.includes(ch) && !font.any) return null;
        nw += n !== undefined ? n : avg;
      }
      const d = ow ? (nw - ow) / ow : 0;
      worst = Math.max(worst, d > 0 ? d * 2 : -d);
    }
    return worst;
  }
  // Every original value in the folder and every stand-in already given: a stand-in is none of
  // them, so no two people end up sharing a value and nothing reads as someone else's original.
  let TAKEN = new Set();
  /** [score, stand-in] for one of the best-fitting candidates, or null when none can be written. */
  function chooseScored(it, candidates) {
    const scored = [];
    for (const c of candidates) { if (TAKEN.has(c.toUpperCase())) continue; const s = fit(it, c); if (s !== null) scored.push([s, c]); }
    if (!scored.length) return null;
    scored.sort((a, b) => a[0] - b[0]);
    const near = scored.filter((x) => x[0] <= scored[0][0] + 0.03).slice(0, 8);
    return pick(near);
  }
  function choose(it, candidates) { const got = chooseScored(it, candidates); return got ? got[1] : null; }
  // A score the spacing can absorb: up to 5% wider (scored double) or 10% narrower. Spread
  // spacing tightens each gap by at most 50 thousandths of an em, which a 2-letter word needs
  // all of to take back 5%; a wider stand-in runs into the next character and the file is refused.
  const FITS = 0.1;

  // ---------------------------------------------------------------- stand-ins
  /** A made-up word that keeps the first letter, and every vowel a vowel and consonant a
   * consonant, so it can be said aloud. For a length no list covers. */
  function pseudo(word) {
    let out = word[0];
    for (let i = 1; i < word.length; i++) {
      const ch = word[i].toLowerCase();
      out += !/[a-z]/.test(ch) ? word[i] : VOWELS.includes(ch) ? pick(VOWELS) : pick(CONS);
    }
    return copyCase(word, out);
  }
  function shuffled(list) { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  /** The pick for a word: a real one, as wide as the word where it is printed. The same length
   * first (nothing around it has to make room), then one to three letters longer or shorter;
   * from each list in turn, the same initial first; among the popular names of the list, at
   * random. Fitting comes before the initial and before the length: a stand-in that runs into
   * the next character gets its whole file refused. A made-up word only when no real one can be
   * written there at all. */
  function wordFor(it, lists, used, extra = []) {
    const w = it.display, len = w.length;
    const ok = (c) => c.toLowerCase() !== w.toLowerCase() && !used.has(c.toUpperCase());
    let closest = null;
    for (const d of [0, 1, 2, 3]) {
      for (const by of extra.length && !d ? lists.concat([new Map([[len, extra]])]) : lists) {
        const pool = [];
        for (const L of d ? [len - d, len + d] : [len]) for (const c of (by.get(L) || []).slice(0, 400)) if (ok(c)) pool.push(c);
        const mixed = shuffled(pool), same = mixed.filter((c) => c[0].toUpperCase() === w[0].toUpperCase());
        for (const cands of [same, mixed]) {
          const got = chooseScored(it, cands);
          if (!got) continue;
          if (got[0] <= FITS) return got[1];
          if (!closest || got[0] < closest[0]) closest = got;
        }
      }
    }
    const made = [];
    for (let t = 0; t < 200; t++) { const p = pseudo(title(w)); if (p.toLowerCase() !== w.toLowerCase() && !used.has(p.toUpperCase())) made.push(p); }
    const m = chooseScored(it, made);
    if (m && (m[0] <= FITS || !closest || m[0] < closest[0])) return m[1];
    return closest ? closest[1] : null;
  }
  function nameFor(it, used) {
    if (it.display.length === 1) {
      // another letter, and not another initial of the folder's (two initials never trade places)
      const letters = "ABCDEFGHJKLMNPRSTW".split("").filter((c) => c !== it.display.toUpperCase());
      const free = letters.filter((c) => !TAKEN.has(c));
      return copyCase(it.display, pick(free.length ? free : letters));
    }
    const w = it.display, roles = it.folderRoles && it.folderRoles.size ? it.folderRoles : it.roles || new Set();
    // a middle name is a first name; a surname list only for a word only ever seen as a surname
    // seen both ways ("Juniper Halvorsen" and a line read as "Halvorsen Juniper"): the way it was
    // seen more often, then the lists
    const count = (r) => (it.roleCount && it.roleCount.get(r)) || 0;
    const asFirst = count("first") + count("middle"), asLast = count("last");
    const firstish = (roles.has("first") || roles.has("middle")) && !roles.has("last") ? true : roles.has("last") && !roles.has("first") && !roles.has("middle") ? false
      : asFirst !== asLast ? asFirst > asLast : FIRST_SET.has(w.toLowerCase());
    const lower = w.toLowerCase();
    // gender from the lists, else from the ending most names in the folder's languages follow
    // what the folder says ("Daughter") first, then the lists, then the ending
    const known = FEMALE_SET.has(lower) || MALE_SET.has(lower);
    const female = it.gender > 0 || (!it.gender && (FEMALE_SET.has(lower) || (!known && /a$/.test(lower))));
    const male = it.gender < 0 || (!it.gender && (MALE_SET.has(lower) || (!known && /o$/.test(lower))));
    const firsts = female ? FEMALE_BY : male ? MALE_BY : FIRST_BY;
    return firstish ? wordFor(it, [firsts, FIRST_BY], used) : wordFor(it, [LAST_BY], used, surnames(w.length));
  }
  const businessFor = (it, used) => wordFor(it, [BUSINESS_BY, STREET_BY], used, surnames(it.display.length));

  /** Where an address's places move to: its own state unless the state item is ticked, then the
   * state the stand-in names. */
  function targetState(items, st) {
    const it = items.get("state:" + st);
    return it && it.checked && it.replacement ? it.replacement : st;
  }
  /** A real state for a ticked state item: one with many cities, so its addresses have room. */
  function stateFor(it) {
    const cands = [...places().states.keys()].filter((st) => st !== it.display && st !== "DC" && places().states.get(st).cities.size > 300);
    const fits = cands.filter((st) => (fit(it, st) ?? Infinity) <= FITS);
    return choose(it, fits.length ? fits : cands);
  }
  /** A ZIP stand-in printable wherever the ZIP is, and wherever its ZIP+4s are. */
  function zipOk(items, zip, code) {
    if (fit(zip, code) === null) return false;
    for (const o of items.values()) if (o.kind === "zip4" && o.display.startsWith(zip.display + "-") && fit(o, code + o.display.slice(5)) === null) return false;
    return true;
  }
  /** The ZIPs that follow a city: found printed with it. */
  const zipsOf = (items, cityIt) => [...items.values()].filter((z) => z.kind === "zip" && z.city === cityIt.key);
  /** A real city of the same length and shape in the target state, whose own ZIPs can be
   * printed wherever this city's ZIPs are. */
  function cityFor(items, it) {
    const st = targetState(items, it.state), s = places().states.get(st);
    if (!s) return null;
    // only the ZIPs being swapped need a stand-in of the new city's
    const zips = zipsOf(items, it).filter((z) => z.checked);
    // best, a ZIP of its own for every ZIP the original has in the folder; else one at least for
    // each, and the rest are real ZIPs beside it (zipFor)
    const enough = (c, all) => {
      const free = s.cities.get(cityKey(c)).std.filter((code) => !TAKEN.has(code) && !zips.some((z) => z.display === code));
      return (!all || free.length >= zips.length) && zips.every((z) => free.some((code) => zipOk(items, z, code)));
    };
    // a real city with as many words, the same length first, then up to four letters either way
    const nWords = it.display.trim().split(/\s+/).length, len = it.display.length;
    let same = [];
    for (const d of [0, 1, 2, 3, 4]) {
      for (const L of d ? [len - d, len + d] : [len]) for (const c of s.byLen.get(L) || []) if (c.split(/\s+/).length === nWords && cityKey(c) !== cityKey(it.display)) same.push(c);
      if (same.filter((c) => !TAKEN.has(c.toUpperCase()) && (fit(it, c) ?? Infinity) <= FITS).length >= 6) break;
    }
    let pool = same.filter((c) => enough(c, true));
    if (!pool.some((c) => (fit(it, c) ?? Infinity) <= FITS)) pool = same.filter((c) => enough(c, false));
    // of the cities that fit the width, one with several ZIPs of its own (a place people live),
    // then one with the same initial
    const fitting = pool.filter((c) => !TAKEN.has(c.toUpperCase()) && (fit(it, c) ?? Infinity) <= FITS);
    const size = (c) => s.cities.get(cityKey(c)).std.length;
    const initial = (list) => list.filter((c) => c[0].toUpperCase() === it.display[0].toUpperCase());
    const nearest = (list) => { const best = Math.min(...list.map((c) => Math.abs(c.length - len))); return list.filter((c) => Math.abs(c.length - len) === best); };
    for (const min of [5, 3, 2, 1]) {
      const tier = fitting.filter((c) => size(c) >= min);
      if (tier.length) { const near = nearest(tier); return pick(initial(near).length ? initial(near) : near); }
    }
    // no real city of this length and shape fits where it is printed ("West Palm Beach"): the
    // city is kept, so the address stays a real one, rather than given a made-up or too-wide name
    return KEEP;
  }
  const KEEP = Symbol("keep");
  /** A real ZIP: one of the stand-in city's; when a folder holds more ZIPs of one city than the
   * stand-in city has (forty clients across a metro), a real ZIP beside them (same first three
   * digits), then any in the state. With the city kept: another of the city's own, then one
   * starting with the same three digits, then any in the state. */
  function zipFor(items, it) {
    const city = it.city && items.get(it.city);
    // a kept city keeps its own state, and its ZIP becomes another of its own, or stays
    if (city && city.kept) {
      const own = ((places().states.get(city.state) || { cities: new Map() }).cities.get(cityKey(city.display)) || { std: [] }).std;
      return choose(it, own.filter((z) => z !== it.display && !TAKEN.has(z) && zipOk(items, it, z))) || KEEP;
    }
    const st = targetState(items, it.state || places().zipState.get(it.display));
    const s = places().states.get(st);
    if (!s) return null;
    const free = (codes) => codes.filter((z) => z !== it.display && !TAKEN.has(z) && zipOk(items, it, z));
    const tiers = [];
    const all = [...s.cities.values()].flatMap((c) => c.std);
    if (city && city.checked && city.replacement) {
      // the stand-in city's own ZIPs, else a real ZIP beside them (same first three digits)
      const own = (s.cities.get(cityKey(city.replacement)) || { std: [] }).std;
      const near = new Set(own.map((z) => z.slice(0, 3)));
      tiers.push(free(own), free(all.filter((z) => near.has(z.slice(0, 3)))), free(all));
    } else {
      if (city) tiers.push(free((s.cities.get(cityKey(city.display)) || { std: [] }).std));
      tiers.push(free(all.filter((z) => z.slice(0, 3) === it.display.slice(0, 3))), free(all));
    }
    for (const cands of tiers) { const got = choose(it, cands); if (got) return got; }
    return null;
  }

  // Digits are drawn only from the digits every font that prints the value carries: an embedded
  // subset may hold six digits of ten.
  let POOL = "0123456789";
  function digitPool(it) {
    let pool = "0123456789";
    for (const { font } of (it.ctx || new Map()).values()) if (!font.problem) pool = [...pool].filter((d) => font.widths.has(d)).join("");
    return pool.length >= 2 ? pool : "0123456789";
  }
  const dg = () => POOL[rand(POOL.length)];
  const dgNZ = () => { const nz = POOL.replace("0", ""); return nz ? nz[rand(nz.length)] : dg(); };
  const pad = (n, w) => String(n).padStart(w, "0");
  function randomDigitsLike(form) {
    let first = true;
    return form.replace(/\d/g, () => { const d = first ? dgNZ() : dg(); first = false; return d; });
  }
  const digits = (n) => Array.from({ length: n }, dg).join("");
  /** Whether two card numbers are one number read twice: the same once letters a reader mistakes
   * for digits are read as digits, give or take two characters. */
  function sameNumber(a, b) {
    const n = (v) => v.toUpperCase().replace(/[\s-]/g, "").replace(/[OQD]/g, "0").replace(/[IL]/g, "1").replace(/B/g, "8").replace(/S/g, "5").replace(/Z/g, "2").replace(/G/g, "6");
    const x = n(a), y = n(b);
    if (Math.abs(x.length - y.length) > 2 || Math.min(x.length, y.length) < 7) return false;
    let row = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
      const next = [i];
      for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      row = next;
    }
    return row[y.length] <= 2;
  }
  function chooseMade(it, make, tries = 400) {
    POOL = digitPool(it);
    const made = [];
    for (let t = 0; t < tries && made.length < 40; t++) { const c = make(); if (c && c !== it.display && fit(it, c) !== null) made.push(c); }
    POOL = "0123456789";
    return choose(it, made);
  }
  /** A valid-looking SSN (area 001-899 but not 666, group and serial not zero), or an ITIN when
   * the original is one (9xx with the middle group in the IRS's ITIN ranges). */
  function ssnLike(display) {
    const itin = display.startsWith("9");
    // as many leading zeros as the original: a number that dropped them prints as many digits
    const zeros = display.replace(/\D/g, "").match(/^0*/)[0].length;
    const area = itin ? "9" + digits(2) : zeros === 2 ? "00" + (1 + rand(9)) : zeros === 1 ? "0" + String(10 + rand(90)) : String(100 + rand(800));
    const group = digits(2), serial = digits(4);
    const g = +group;
    if (itin ? !((g >= 50 && g <= 65) || (g >= 70 && g <= 88) || (g >= 90 && g <= 92) || g >= 94) : (+area === 0 || +area === 666 || +area >= 900)) return null;
    if (g === 0 || +serial === 0) return null;
    return area + "-" + group + "-" + serial;
  }
  const KEEP_STREET = /^(n|s|e|w|ne|nw|se|sw|north|south|east|west|st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|cir|circle|ter|terrace|trl|trail|hwy|highway|loop|sq|square|row|run|pass|path|xing|ste|suite|apt|unit|bldg|fl|floor|rm|room|po|box|calle|camino|paseo|avenida|via|vista|placita|rancho|callejon|circulo|entrada|corte|del|de|la|las|los|el|of|the)\.?$/i;
  // words a street's name ends in ("Larkspur Ridge", "Willow Creek"): kept, and the name before
  // them changed, so the street still reads as one
  const STREET_TAIL = new Set(("ridge hill hills creek park lake lakes valley view point heights hollow crossing glen grove " +
    "meadow meadows spring springs wood woods estates pines oaks village commons landing bend canyon mesa vista ranch farm " +
    "farms station mill brook forest shores harbor bay cove summit peak knoll bluff gate chase green field fields acres " +
    "manor garden gardens island isle beach river pointe trace").split(" "));
  function streetLike(display) {
    const parts = display.split(/(\s+)/);
    const named = parts.filter((w) => /^[A-Za-z']+$/.test(w) && !KEEP_STREET.test(w));
    const keepTail = named.length > 1;
    return parts.map((w) => {
      if (/^\s+$/.test(w) || KEEP_STREET.test(w)) return w;
      if (keepTail && STREET_TAIL.has(w.toLowerCase())) return w;
      if (/^\d+[A-Za-z]?$/.test(w)) return w.replace(/\d+/, (n) => randomDigitsLike(n));
      if (/^[A-Za-z']+$/.test(w)) {
        let pool = [];
        for (const by of [STREET_BY, STREET_SUR_BY]) {
          for (const L of [w.length, w.length - 1, w.length + 1, w.length - 2, w.length + 2]) for (const c of by.get(L) || []) if (c.toLowerCase() !== w.toLowerCase() && !(keepTail && STREET_TAIL.has(c.toLowerCase()))) pool.push(c);
          if (pool.length) break;
        }
        // the same length two times in three, so most addresses keep their width exactly
        const same = pool.filter((c) => c.length === w.length);
        return copyCase(w, pool.length ? pick(same.length && rand(3) ? same : pool) : pseudo(title(w)));
      }
      return w;
    }).join("");
  }

  /** A stand-in for every item that has none. Values that depend on another (a masked SSN on
   * its full SSN, a ZIP+4 on its ZIP, an email on its owner's names) are made after it. */
  function generate(items) {
    const all = [...items.values()];
    const used = new Set(all.filter((i) => i.replacement).map((i) => i.replacement.toUpperCase()));
    TAKEN = new Set();
    for (const i of all) { TAKEN.add(i.display.toUpperCase()); if (i.replacement) TAKEN.add(i.replacement.toUpperCase()); }
    const give = (it, value) => { it.replacement = value; if (value) TAKEN.add(value.toUpperCase()); };
    const todo = (kind) => all.filter((i) => i.kind === kind && !i.replacement);
    for (const it of todo("name")) { give(it, nameFor(it, used)); if (it.replacement) used.add(it.replacement.toUpperCase()); }
    for (const it of todo("business")) { give(it, businessFor(it, used)); if (it.replacement) used.add(it.replacement.toUpperCase()); }
    for (const it of todo("state")) give(it, stateFor(it));
    // a value kept on purpose has itself as its stand-in, and says so
    const giveOrKeep = (it, v) => { it.kept = v === KEEP; give(it, it.kept ? it.display : v); };
    for (const it of todo("city")) giveOrKeep(it, cityFor(items, it));
    // a masked copy (***-**-1234) and an account ending in the SSN's last four take those digits
    // from the SSN's stand-in, so the four have to be printable wherever those are printed too
    for (const it of todo("ssn")) {
      const linked = all.filter((o) => (o.kind === "ssn4" || o.kind === "acct") && o.linked === it.key);
      give(it, chooseMade(it, () => {
        const c = ssnLike(it.display);
        return c && linked.every((o) => fit(o, o.display.slice(0, -4) + c.slice(-4)) !== null) ? c : null;
      }));
    }
    for (const it of todo("ein")) give(it, chooseMade(it, () => it.display.slice(0, 3) + digits(7)));
    for (const it of todo("zip")) giveOrKeep(it, zipFor(items, it));
    for (const it of todo("phone")) {
      const area = it.display.replace(/\D/g, "").slice(0, 3);
      give(it, chooseMade(it, () => fromDigits(it.display, area + "55501" + digits(2)))
        || chooseMade(it, () => fromDigits(it.display, area + dgNZ() + digits(6))));
    }
    for (const it of todo("unit")) give(it, chooseMade(it, () => it.display.replace(/\d+/g, (n) => randomDigitsLike(n))));
    for (const it of todo("street")) { give(it, chooseMade(it, () => streetLike(it.display), 200)); if (it.replacement) used.add(it.replacement.toUpperCase()); }
    for (const it of todo("ssn4")) {
      const full = it.linked && items.get(it.linked);
      if (full && full.replacement) give(it, it.display.slice(0, -4) + full.replacement.slice(-4));
      else give(it, chooseMade(it, () => { const d = digits(4); return +d ? it.display.slice(0, -4) + d : null; }));
    }
    // a ZIP+4 always starts with its ZIP's stand-in; one made before the ZIP's is made again
    for (const it of all) if (it.kind === "zip4" && it.replacement && !it.edited) {
      const zip = items.get("zip:" + it.display.slice(0, 5));
      if (zip && zip.replacement && !it.replacement.startsWith(zip.replacement + "-")) it.replacement = null;
    }
    for (const it of todo("zip4")) {
      const zip = items.get("zip:" + it.display.slice(0, 5));
      const head = zip && zip.replacement ? zip.replacement : it.display.slice(0, 5);
      give(it, chooseMade(it, () => head + "-" + digits(4)));
    }
    for (const it of todo("acct")) {
      const full = it.linked && items.get(it.linked);
      const tail = full && full.replacement ? full.replacement.slice(-4) : null;
      give(it, chooseMade(it, () => {
        // letters and dashes stay, a year stays (2025), every other digit is new
        const body = tail ? it.display.slice(0, -4) : it.display;
        const neu = body.replace(/\d+/g, (run) => (/^(19|20)\d\d$/.test(run) ? run : randomDigitsLike(run)));
        return tail ? neu + tail : neu;
      }));
    }
    // a licence or ID number: every digit and every letter new, its dashes and spaces where they
    // were. A scan the reader got a letter or two wrong in ("D0OB9Y54796" for "D08954796") is the
    // same number, and gets the same stand-in: the number found in the most files is the true one
    const ids = todo("idnum").sort((a, b) => b.files.size - a.files.size || a.display.length - b.display.length);
    for (const it of ids) {
      const same = ids.find((o) => o !== it && o.replacement && sameNumber(o.display, it.display));
      // letters a reader never mistakes for a figure or for each other (no B, D, G, I, O, Q, S, V,
      // W or Z): a card number read back off a scan has to read as painted
      give(it, same ? same.replacement : chooseMade(it, () => it.display.replace(/[0-9]/g, () => digits(1)).replace(/[A-Z]/g, () => "ACEFHJKLMNPRTUXY"[rand(16)]).replace(/[a-z]/g, () => "acefhjkmnprtuxy"[rand(15)])));
    }
    for (const it of todo("dob")) give(it, chooseMade(it, () => {
      const [a, b, c] = it.display.split(/[\/.-]/), sep = it.display.match(/[\/.-]/)[0];
      const pad = (n, w) => String(n).padStart(w, "0");
      const mm = 1 + rand(12), dd = 1 + rand(28);
      const year = c.length === 4 ? String(Math.min(2010, Math.max(1920, +c + rand(7) - 3))) : pad((+c + rand(7) - 3 + 100) % 100, 2);
      const m1 = a.length === 2 ? pad(mm, 2) : String(mm), d1 = b.length === 2 ? pad(dd, 2) : String(dd);
      const out = m1 + sep + d1 + sep + year;
      return out.length === it.display.length ? out : null;
    }));
    // the dates an ID card was issued and expires all move by one span of days, so the card is
    // still valid for as long, and expires after it was issued
    const shift = (rand(2) ? 1 : -1) * (45 + rand(320));
    // a licence that expires on its holder's birthday still does, on the stand-in birthday
    const births = all.filter((o) => o.kind === "dob" && o.replacement).map((o) => [o.display.split(/[\/.-]/), o.replacement.split(/[\/.-]/)]);
    for (const it of todo("iddate")) give(it, (() => {
      const parts = it.display.split(/[\/.-]/), sep = it.display.match(/[\/.-]/)[0];
      const bd = births.find(([o]) => +o[0] === +parts[0] && +o[1] === +parts[1]);
      if (bd) {
        const pad = (n, w) => String(+n).padStart(w, "0");
        return pad(bd[1][0], parts[0].length) + sep + pad(bd[1][1], parts[1].length) + sep + parts[2];
      }
      const year = parts[2].length === 2 ? 2000 + +parts[2] : +parts[2];
      const d = new Date(Date.UTC(year, +parts[0] - 1, +parts[1]));
      if (isNaN(d)) return null;
      d.setUTCDate(d.getUTCDate() + shift);
      const pad = (n, w) => String(n).padStart(w, "0");
      const y = parts[2].length === 2 ? pad(d.getUTCFullYear() % 100, 2) : String(d.getUTCFullYear());
      return pad(d.getUTCMonth() + 1, parts[0].length) + sep + pad(d.getUTCDate(), parts[1].length) + sep + y;
    })());
    const nameMap = new Map(all.filter((i) => WORDISH.has(i.kind) && i.replacement).map((i) => [i.display.toLowerCase(), i.replacement]));
    for (const it of todo("email")) {
      const [local, domain] = it.display.split("@");
      // a name or a business word is changed wherever it sits in the address ("orchidlane"),
      // and in the part before the @ every other run of letters is made up
      const words = [...nameMap].filter(([w]) => w.length >= 4).sort((a, b) => b[0].length - a[0].length);
      const runs = (s, all) => s.replace(/[A-Za-z]+/g, (run) => {
        const r = nameMap.get(run.toLowerCase());
        if (r) return copyCase(run, r);
        let neu = run, hit = false;
        for (const [w, rep] of words) neu = neu.replace(new RegExp(w, "gi"), (m) => { hit = true; return copyCase(m, rep); });
        return hit ? neu : all ? pseudo(run) : run;
      });
      give(it, runs(local, true).replace(/\d/g, () => String(rand(10))) + "@" + runs(domain, false));
    }
    return items;
  }
  /** What follows from an item's stand-in: a full SSN's masked copies and accounts, a ZIP's
   * ZIP+4, a city's ZIPs, a state's cities (and so theirs). An edited one is left as typed. */
  function dependents(items, it, out = []) {
    for (const o of items.values()) {
      if (o.edited || out.includes(o)) continue;
      const follows = (it.kind === "ssn" && (o.kind === "ssn4" || o.kind === "acct") && o.linked === it.key)
        || (it.kind === "zip" && o.kind === "zip4" && o.display.startsWith(it.display + "-"))
        || (it.kind === "city" && o.kind === "zip" && o.city === it.key)
        || (it.kind === "state" && o.kind === "city" && o.state === it.display);
      if (follows) { out.push(o); dependents(items, o, out); }
    }
    return out;
  }
  /** A new stand-in for one item (the New button), and for what follows from it. */
  function regenerate(items, it) {
    it.replacement = null;
    follow(items, it);
  }
  /** After an item's stand-in is edited, or its tick changes: what follows from it is chosen again. */
  function follow(items, it) {
    for (const d of dependents(items, it)) d.replacement = null;
    generate(items);
  }

  // ---------------------------------------------------------------- rows for the engine
  function allRows(items, phrases, custom = []) {
    const rows = [], seen = new Set();
    const push = (find, replace, label) => {
      if (!find || !replace || find === replace || seen.has(find)) return;
      seen.add(find); rows.push({ id: rows.length + 1, find, replace, label });
    };
    for (const c of custom) push(c.find, c.replace, "your swap");
    const nameMap = new Map();
    // a moved state is moved only inside its address lines ("Tucson, AZ"), never in a form's
    // title ("AZ Form 140"); the city beside it moves with it
    // A city is swapped everywhere, or, when it is also an everyday word or a person's name
    // (Mesa, Chandler), only beside its state code
    for (const city of items.values()) {
      if (city.kind !== "city") continue;
      const st = items.get("state:" + city.state), moved = st && st.checked && st.replacement;
      // a kept city keeps its state beside it too: the address stays one real place
      if (city.kept) continue;
      const swapped = city.checked && city.replacement;
      if (!swapped && !moved) continue;
      if (swapped && !city.risky) for (const [f, r] of formsFor(city, city.replacement, false)) push(f, r, "city");
      for (const [f, r] of formsFor(city, swapped ? city.replacement : city.display))
        for (const sep of [", ", ",", " ", ",  ", "  "]) push(f + sep + city.state, r + sep + (moved ? st.replacement : city.state), "city");
    }
    for (const it of items.values()) {
      if (!it.checked || !it.replacement || it.kind === "state" || it.kind === "city") continue;
      if (WORDISH.has(it.kind)) nameMap.set(it.display.toUpperCase(), it.replacement);
      // a business's first word in small letters is an everyday word, but not in its web address
      // ("acmeplumbing.com", "www.acmeplumbing"): there it names the business
      if (it.kind === "business" && it.lead) {
        const lo = it.display.toLowerCase(), rl = it.replacement.toLowerCase();
        for (const tld of new Set(["com", "net", "org", "us", "co", "io", "biz", "info", ...(it.domains || [])])) push(lo + "." + tld, rl + "." + tld, "business");
        push("www." + lo, "www." + rl, "business");
        push("@" + lo, "@" + rl, "business");
      }
      for (const [f, r] of formsFor(it, it.replacement, false)) {
        if (WORDISH.has(it.kind) && it.phraseOnly && it.phraseOnly.has(f)) continue;
        push(f, r, it.kind);
      }
    }
    // names written only inside the names they were found in
    for (const [text] of phrases) {
      const neu = text.replace(/[\p{L}][\p{L}'’]*/gu, (w) => (nameMap.has(w.toUpperCase()) ? copyCase(w, nameMap.get(w.toUpperCase())) : w));
      if (neu !== text) { push(text, neu, "name"); push(text.toUpperCase(), neu.toUpperCase(), "name"); }
    }
    return rows;
  }
  /** File and folder names, through the same rows. A name written with underscores for spaces
   * ("Withrow_Lynsey_W2.pdf") is read with spaces and written with underscores again. */
  function renamePath(path, prepared) {
    return path.split("/").map((seg) => {
      const dot = seg.lastIndexOf(".");
      const [stemPart, ext] = dot > 0 ? [seg.slice(0, dot), seg.slice(dot)] : [seg, ""];
      const under = stemPart.includes("_") && !stemPart.includes(" ");
      const swapped = E().swapPlain(under ? stemPart.replace(/_/g, " ") : stemPart, prepared)[0];
      return (under ? swapped.replace(/ /g, "_") : swapped) + ext;
    }).join("/");
  }

  /** A word a person's name could be by itself: on the name lists and not also an everyday English
   * word ("Marisol" is, "Grace" and "Review" are not). The hush step uses it to read a name in
   * running text that no folder name vouches for. */
  const plainName = (w) => inLists(w) && !WORDLIKE.has(w.toLowerCase());
  /** On the first-name lists, and on the surname lists: each alone is weak evidence in running
   * text, a first name followed by a surname is a person. */
  const firstName = (w) => FIRST_SET.has(w.toLowerCase());
  const surname = (w) => LAST_SET.has(w.toLowerCase());

  return { profile, textProfile, detect, attachContexts, generate, regenerate, follow, formsFor, fit, FITS, allRows, folderName, realCity, cityKey, renamePath, copyCase, nameTokens, pseudo, plainName, firstName, surname, lists: { FIRST, LAST, STREET } };
})();
globalThis.PDFSwapPII = PDFSwapPII;
if (typeof module !== "undefined") module.exports = PDFSwapPII;
