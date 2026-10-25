"""The identity swap page finds people, businesses and places, never a form's own words, and gives
each a stand-in that is real where a reader could check it.

web/'s finding and choosing run in node over a synthetic client folder shaped
like a firm's real one (identity_swap_probe.js, invented people, real public places). What is
held:

  * a form's words are never names: "Self-Employed", "Identity Protection", "Overpayment",
    "Relationship", "QSS", an occupation, a lone state code, a label before a colon, a folder
    called Private, words in capitals on the line after a name label that hold no known name, a
    greeting ("Dear"); an instruction ("15 Subtract ln 14", "43 When did you place") is never a
    street, and a suite is never part of one
  * the people are found: the client folder's names, a dependent beside the family name, the
    preparer on the line after "Preparer's name"; and in a second household, dependents named
    only in a sentence or a table ("we have Marigold Ostrander and Caspian Ostrander as
    dependents", "Dependent 1   Marigold Ostrander"), a middle initial, an employer written
    without LLC or Inc, an SSN a spreadsheet keeps as nine digits beside its label, and a spouse
    a reader read with one space between the fields ("Spouse: Dmitri Vance SSN 529-61-0447"),
    whose first name no table holds and whose surname is also a word ("Spouse: Not Applicable"
    stays)
  * a middle initial and a business's words after its first are swapped only inside the names
    they were found in, never on their own ("the survey was mailed" stays), while the business's
    name inside a web address is swapped whatever the address ends in; a child the folder calls a
    daughter or a son gets a stand-in from that list
  * the chosen folder is the client when it is named like one, and a Mac's ._ files and
    __MACOSX are system files, never documents
  * every city's stand-in is a real city in its state with as many words and nearly as many
    letters, every ZIP's a real ZIP of that city, every ZIP+4 starts with its ZIP's stand-in,
    and no stand-in is any value the folder holds
  * the state is kept unless ticked; ticked, the address moves to a real city and ZIP of the
    new state while the state's own forms ("AZ Form 140") keep its name
  * a city of three words ("West Palm Beach") moves to a real city of three words in its state;
    one no real city of its state can stand in for ("Hot Springs National Park") is kept, with
    its own state beside it and a ZIP of its own, rather than given a made-up name
  * a business keeps what kind of business it is ("Consulting LLC")
  * every line keeps its words in their places (a stand-in has as many words as its value),
    and the tree keeps its shape under the swapped names
  * on an ID card, read with its small labels lost, every date is found (a birthday when it is
    far enough back to be one, the card's own date otherwise, an issue date run into the next
    field included), every long card number is found with no label left, the names on the
    card's numbered lines are found, an expiry on the birthday stays on the stand-in birthday,
    and a fax of the card read with letters for digits gets the same stand-in number; a letter
    that is not a card gets none of that

Skipped where node is absent.
"""

import json
import os
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_probe.js")
PLACES = os.path.join(ROOT, "web", "places.js")

FORM_WORDS = {"Self", "Employed", "Identity", "Protection", "Overpayment", "Joint", "Relationship",
              "Consultant", "Private", "Qss", "Az", "Owner", "Daughter", "Subtract", "Consulting",
              "Digital", "Lane", "Tax", "Preparer", "Payer", "Recipient", "Sole", "Proprietor", "Dear"}


@pytest.fixture(scope="module")
def probe():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed - the page's rules cannot be run here")
    r = subprocess.run([node, PROBE], capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.fixture(scope="module")
def places():
    with open(PLACES, encoding="utf-8") as fh:
        src = fh.read()
    body = src[src.index("=") + 1: src.index(";\nglobalThis")]
    out = {}
    for st, packed in json.loads(body).items():
        cities = {}
        for entry in packed.split(";"):
            name, zips = entry.split("|")
            cities[name.upper()] = {z for z in zips.split(",") if not z.startswith("*")}
        out[st] = cities
    return out


def items(run, kind):
    return [i for i in run["items"] if i["kind"] == kind]


def runs(probe):
    """The two runs over the first household (its state kept, then moved)."""
    return [(k, probe[k]) for k in ("kept", "moved")]


def test_no_form_word_is_taken_for_a_name(probe):
    for _, run in runs(probe):
        found = {i["display"] for i in run["items"] if i["kind"] in ("name", "business")}
        assert not found & FORM_WORDS, found & FORM_WORDS


def test_the_people_are_found_where_names_sit(probe):
    names = {i["display"] for i in items(probe["kept"], "name")}
    assert {"Marisol", "Quillfeather", "Elena", "Nolan", "Vasquez"} <= names, names
    for _, run in runs(probe):
        greeting = run["after"][run["before"].index("Dear Marisol,")]
        assert greeting.startswith("Dear ") and greeting != "Dear Marisol,", greeting


def test_instructions_are_not_streets_and_a_suite_is_not_part_of_one(probe):
    streets = {i["display"] for i in items(probe["kept"], "street")}
    assert streets == {"4417 E SAGUARO BLOSSOM RD", "3100 VISTA RIDGE PKWY", "1200 Ocean Breeze Way", "210 Cedar Glen Rd"}, streets
    assert {i["display"] for i in items(probe["kept"], "unit")} == {"STE 200", "PO BOX 4400"}


def test_the_chosen_folder_is_the_client_and_mac_files_are_not_documents(probe):
    assert probe["kept"]["clients"] == ["Quillfeather, Marisol J"]
    assert probe["kept"]["kinds"] == ["pdf", "pdf", "other", "system", "system"]


def test_every_city_and_zip_stand_in_is_a_real_place_that_belongs_together(probe, places):
    for label, run in runs(probe):
        by_key = {i["key"]: i for i in run["items"]}
        moved = {i["display"]: i["replacement"] for i in items(run, "state") if i["checked"]}
        for city in items(run, "city"):
            if city["kept"]:
                assert city["replacement"] == city["display"], city
                continue
            st = moved.get(city["state"], city["state"])
            rep = city["replacement"]
            assert rep and len(rep.split()) == len(city["display"].split()), city
            assert abs(len(rep) - len(city["display"])) <= 4, city
            assert rep.upper() in places[st], "%s: %s is not a city in %s" % (label, rep, st)
        for z in items(run, "zip"):
            city = by_key[z["city"]]
            st = city["state"] if city["kept"] else moved.get(city["state"], city["state"])
            assert z["replacement"] in places[st][city["replacement"].upper()], (label, z, city)
        zips = {z["display"]: z["replacement"] for z in items(run, "zip")}
        for z4 in items(run, "zip4"):
            assert z4["replacement"].startswith(zips[z4["display"][:5]] + "-"), z4


def test_no_stand_in_is_a_value_the_folder_holds(probe):
    for _, run in runs(probe) + [("family", probe["family"])]:
        originals = {i["display"].upper() for i in run["items"]}
        for i in run["items"]:
            if i["kind"] != "state" and i["replacement"] and not i["kept"]:
                assert i["replacement"].upper() not in originals, i


def test_the_state_is_kept_unless_ticked_and_its_forms_keep_its_name(probe):
    kept, moved = probe["kept"], probe["moved"]
    assert all(not i["checked"] for i in items(kept, "state"))
    for run in (kept, moved):
        assert "AZ Form 140 Arizona Resident Personal Income Tax Return" in run["after"]
        assert "AZ" in run["after"], "a lone state code is a form's label and stays"
    home = kept["before"].index("TUCSON AZ 85711")
    zips = {z["display"]: z["replacement"] for z in items(kept, "zip")}
    assert kept["after"][home].endswith(" AZ " + zips["85711"])
    st = next(i for i in items(moved, "state") if i["display"] == "AZ")["replacement"]
    zips = {z["display"]: z["replacement"] for z in items(moved, "zip")}
    assert moved["after"][home].endswith(" %s %s" % (st, zips["85711"])), moved["after"][home]


def test_form_lines_read_as_they_did_and_every_line_keeps_its_words(probe):
    for _, run in runs(probe) + [("family", probe["family"])]:
        for before, after in zip(run["before"], run["after"]):
            assert len(before.split()) == len(after.split()), (before, after)
    for _, run in runs(probe):
        for line in ("Identity Protection PIN, see instructions", "Qualifying surviving spouse (QSS)",
                     "Protection of Joint Overpayment", "15 Subtract ln 14 from ln 13",
                     "43 When did you place the vehicle in service", "Your occupation CONSULTANT",
                     "Firm's name (or yours if self-employed)", "(PREPARER'S IF SELF-EMPLOYED)"):
            assert line in run["after"], line
        business = run["after"][run["before"].index("ORCHID LANE CONSULTING LLC")]
        assert business.endswith(" LANE CONSULTING LLC") and not business.startswith("ORCHID"), business


def test_the_tree_keeps_its_shape_under_the_swapped_names(probe):
    for _, run in runs(probe):
        for before, after in zip(run["paths"], run["renamed"]):
            assert before.count("/") == after.count("/"), (before, after)
            assert [len(seg.split()) for seg in before.split("/")] == [len(seg.split()) for seg in after.split("/")], (before, after)
            assert "Quillfeather" not in after and "Marisol" not in after
            kept = [seg for seg in before.split("/") if not any(w in seg for w in ("Quillfeather", "Marisol", "Brightspan", "Orchid"))]
            assert all(seg in after.split("/") for seg in kept), (before, after)


def test_a_city_of_three_words_moves_to_a_real_city_of_three_words(probe, places):
    for label, run in runs(probe):
        city = next(i for i in items(run, "city") if i["display"] == "West Palm Beach")
        rep = city["replacement"]
        assert not city["kept"] and len(rep.split()) == 3 and rep.upper() in places["FL"], (label, city)
        z = next(i for i in items(run, "zip") if i["display"] == "33401")
        line = run["after"][run["before"].index("Mail to: 1200 Ocean Breeze Way, West Palm Beach, FL 33401")]
        assert line.endswith("%s, FL %s" % (rep, z["replacement"])), (label, line)
        assert "Ocean Breeze" not in line, "the street is still swapped"


def test_a_city_no_real_stand_in_fits_is_kept_with_its_own_state_and_a_zip_of_its_own(probe, places):
    """No other Arkansas city has four words: "Hot Springs National Park" is kept rather than
    given a made-up name, its state stays beside it even when the state is moved elsewhere, and
    its ZIP becomes another of its own."""
    for label, run in runs(probe):
        city = next(i for i in items(run, "city") if i["display"] == "Hot Springs National Park")
        assert city["kept"] and city["replacement"] == "Hot Springs National Park", (label, city)
        z = next(i for i in items(run, "zip") if i["display"] == "71901")
        assert z["replacement"] != "71901" and z["replacement"] in places["AR"]["HOT SPRINGS NATIONAL PARK"], (label, z)
        line = run["after"][run["before"].index("Lake house: 210 Cedar Glen Rd, Hot Springs National Park, AR 71901")]
        assert line.endswith("Hot Springs National Park, AR " + z["replacement"]), (label, line)
        assert "Cedar Glen" not in line, "the street is still swapped"


def found(run, kind):
    return {i["display"]: i["replacement"] for i in items(run, kind)}


def test_dependents_named_only_in_a_sentence_or_a_table_are_found(probe):
    fam = probe["family"]
    names = found(fam, "name")
    assert {"Wilhelmina", "Ostrander", "Leopold", "Marigold", "Caspian"} <= set(names), names
    sentence = fam["after"][fam["before"].index("This year we have Leopold Ostrander as your spouse and Marigold Ostrander "
                                                  "and Caspian Ostrander as dependents.")]
    for w in ("Leopold", "Marigold", "Caspian", "Ostrander"):
        assert w not in sentence, sentence
    assert sentence.startswith("This year we have ") and sentence.endswith(" as dependents."), sentence
    table = fam["after"][fam["before"].index("Dependent 1   Marigold Ostrander")]
    assert table.startswith("Dependent 1   ") and "Marigold" not in table, table


def test_a_spouse_read_with_one_space_between_fields_and_a_name_no_table_holds_is_found(probe):
    # "Spouse: Dmitri Vance SSN 529-61-0447", as a reader gives a line it read: the name stops
    # at the SSN, and the label is evidence enough for a first name the tables lack and a surname
    # that is also a word; a label followed by a form's own words is no name
    fam = probe["family"]
    names = found(fam, "name")
    assert {"Dmitri", "Vance"} <= set(names), names
    line = fam["after"][fam["before"].index("Spouse: Dmitri Vance SSN 529-61-0447")]
    assert line.startswith("Spouse: ") and "Dmitri" not in line and "Vance" not in line and "529-61-0447" not in line, line
    assert fam["after"][fam["before"].index("Spouse: Not Applicable")] == "Spouse: Not Applicable"


def test_a_child_called_a_daughter_or_a_son_gets_a_stand_in_from_that_list(probe):
    fam = probe["family"]
    names = found(fam, "name")
    assert names["Marigold"] in fam["female"], names["Marigold"]
    assert names["Caspian"] in fam["male"], names["Caspian"]


def test_a_middle_initial_is_swapped_inside_the_name_and_nowhere_else(probe):
    fam = probe["family"]
    initial = next(i for i in items(fam, "name") if i["display"] == "T")
    assert len(initial["replacement"]) == 1 and initial["replacement"] != "T" and initial["mode"] == "inside names only", initial
    line = fam["after"][fam["before"].index("Wilhelmina T Ostrander")]
    assert line.split()[1] == initial["replacement"], line
    assert not any(r["find"] == "T" for r in fam["rows"]), "a lone letter is never a row of its own"


def test_an_employer_without_a_legal_form_is_found_and_its_everyday_words_stay_everyday(probe):
    fam = probe["family"]
    biz = found(fam, "business")
    assert "Thornbury" in biz, biz
    for label in ("Employer:   Thornbury Survey Group", "Thornbury Survey Group, 18 N Pine St, Duluth, MN 55802"):
        line = fam["after"][fam["before"].index(label)]
        assert "Thornbury" not in line and "Group" in line, line
    assert "the survey was mailed in March" in fam["after"]
    assert not any(r["find"].lower() == "survey" for r in fam["rows"]), "an everyday word is never a row of its own"
    # the business's name in a web address with an ending nobody listed, as a card statement's
    # payee line prints it
    line = fam["after"][fam["before"].index("Card payment 0412 / thornbury.shop")]
    assert "thornbury" not in line.lower() and line.endswith(".shop"), line


def test_an_ssn_a_spreadsheet_keeps_as_nine_digits_is_found_beside_its_label(probe):
    fam = probe["family"]
    ssns = found(fam, "ssn")
    assert "538-20-4471" in ssns, ssns
    line = fam["after"][fam["before"].index("SSN   538204471")]
    assert line == "SSN   " + ssns["538-20-4471"].replace("-", ""), line


def test_an_id_card_read_with_its_labels_lost_still_gives_up_every_date_and_number(probe):
    card = probe["idcard"]
    on_card = lambda i: any(f.endswith("DL front.png") for f in i["files"])
    kinds = {(i["kind"], i["display"]): i["replacement"] for i in card["items"] if on_card(i)}
    # "3 poe 07/19/1979": a birthday with its label misread
    assert ("dob", "07/19/1979") in kinds, kinds
    # "sais 07/19/2031": the expiry with its label misread; "202215": the issue date run into "15 Sex"
    assert ("iddate", "07/19/2031") in kinds and ("iddate", "06/11/2022") in kinds, kinds
    # the licence number, and the DD number with no label left
    assert ("idnum", "K41702953") in kinds and ("idnum", "7741203CX88301456") in kinds, kinds
    names = {i["display"] for i in card["items"] if i["kind"] == "name"}
    assert {"Harrowgate", "Quenby", "Odette"} <= names, names
    for (kind, value), rep in kinds.items():
        if kind in ("idnum", "dob", "iddate"):
            assert rep and rep != value and len(rep) == len(value), (value, rep)
            # letters stay letters, digits stay digits, separators stay where they were
            assert [c.isdigit() for c in rep] == [c.isdigit() for c in value], (value, rep)


def test_an_expiry_on_the_birthday_is_on_the_stand_in_birthday(probe):
    card = probe["idcard"]
    dob = next(i for i in card["items"] if i["kind"] == "dob" and i["display"] == "07/19/1979")
    exp = next(i for i in card["items"] if i["kind"] == "iddate" and i["display"] == "07/19/2031")
    assert exp["replacement"][:5] == dob["replacement"][:5] and exp["replacement"][-4:] == "2031", (dob, exp)


def test_a_card_number_read_with_letters_for_digits_gets_the_same_stand_in(probe):
    card = probe["idcard"]
    ids = {i["display"]: i["replacement"] for i in card["items"] if i["kind"] == "idnum"}
    assert ids["K4I7O2953"] == ids["K41702953"], ids
    assert ids["7741203CX88301456"] != ids["K41702953"]


def test_a_letter_that_is_not_a_card_has_no_card_dates_or_numbers_of_its_own(probe):
    card = probe["idcard"]
    letter = [i for i in card["items"] if [f for f in i["files"] if f.endswith("Invoice.pdf")] and i["kind"] in ("idnum", "iddate", "dob")]
    assert not letter, letter
