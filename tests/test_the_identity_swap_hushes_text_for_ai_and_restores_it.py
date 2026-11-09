"""The identity swap page hushes text for an AI chat and restores the AI's answer.

web/hush.js runs in node over invented client messages (identity_swap_hush_probe.js). What is
held:

  * every name, SSN, EIN, phone, email, street, city, ZIP, account number, birth date and
    business in a client email becomes a tag, and none of the values is left in the hushed text,
    however it was written again further down ("481273306", "Marisol's", "the Quillfeather
    family"); a word on the list to always hide is hidden too
  * a person's full name is one tag, and the first name or surname alone is that person's
    ("Dear [PERSON-1-FIRST]"); a household's shared surname keeps one tag
  * a second paste with the same key gives the same values the same tags, a phone written
    another way included
  * an answer restores whatever the AI did to the brackets (spaces inside, Markdown escapes),
    and a tag the key does not know is listed and left as written
  * a tag can be renamed ("SPOUSE"), never onto a tag already in use, and the new name holds in
    the next paste
  * the saved key is encrypted (no value readable in the file), opens with its passphrase and
    with nothing else
  * ordinary tax text (forms, schedules, months, credits) is left alone; a person after a label,
    a hyphenated or Irish surname, a greeting's first name, a birth date after "born" and a
    business by its legal ending are hidden; a city and a state code are not taken for names

  * a firm's client list (a CSV export) makes every client a known person, however rare the name:
    without it "Kofi Ostfeather" is missed, with it he is [PERSON-1]
  * a card number is hidden only when its check digit is right (Luhn); a bank's routing number,
    which names a bank and no one's account, is left as written

Skipped where node is absent.
"""

import json
import os
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_hush_probe.js")

SECRETS = ["Marisol", "Quillfeather", "Daniel", "Elena", "481-27-3306", "481273306", "4417 E Saguaro",
           "Tucson", "85711", "555-0142", "marisol.q@gmail.com", "03/14/2015", "Brightspan", "82-1234567",
           "0012345678", "Kip"]


@pytest.fixture(scope="module")
def probe():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed - the page's rules cannot be run here")
    r = subprocess.run([node, PROBE], capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_nothing_personal_is_left_in_the_hushed_email(probe):
    text = probe["first"]["text"]
    left = [s for s in SECRETS if s.lower() in text.lower()]
    assert not left, left
    assert probe["first"]["leaks"] == []
    assert "[HIDDEN-1]" in text


def test_a_person_is_one_tag_and_their_names_alone_are_theirs(probe):
    text = probe["first"]["text"]
    assert "review the return for [PERSON-1] (SSN [SSN-1])" in text
    assert "her spouse [PERSON-2]." in text
    assert "Dependent: [PERSON-3], DOB [DOB-1]" in text
    assert "Dear [PERSON-1-FIRST], your SSN on file is [SSN-1]." in text
    assert "[PERSON-1-FIRST]'s W-2 from [BUSINESS-1]" in text
    assert "The [PERSON-1-LAST] family" in text
    assert "Phone [PHONE-1]," in text  # the area code's bracket goes with it


def test_a_second_paste_keeps_every_tag(probe):
    assert probe["second"]["text"] == "Follow up: [PERSON-2] called from [PHONE-1] about the [BUSINESS-1] W-2."


def test_an_answer_is_restored_and_an_unknown_tag_left_as_written(probe):
    r = probe["restored"]
    assert r["text"] == "Dear Marisol, 481-27-3306 is right; Daniel Quillfeather lives at 4417 E Saguaro Blossom Rd. [FOO-9] is new."
    assert r["unknown"] == ["FOO-9"]


def test_a_tag_can_be_renamed_and_keeps_its_new_name(probe):
    assert probe["renameError"] and "already" in probe["renameError"]
    assert "SPOUSE" in probe["renamedTags"] and "SPOUSE-FIRST" in probe["renamedTags"]
    assert "her spouse [SPOUSE]." in probe["afterRename"]


def test_the_saved_key_is_locked(probe):
    locked = probe["locked"]
    _key_holds_no_value(locked, ["Marisol", "481-27-3306", "Quillfeather", "Kip", "PERSON-1"])
    f = json.loads(locked)
    assert f["cipher"] == "AES-256-GCM" and f["kdf"] == "PBKDF2-SHA-256" and f["iterations"] >= 600000
    assert probe["opened"]["tags"] == probe["opened"]["keyTags"]
    assert probe["opened"]["alwaysHide"] == ["Kip"]
    assert probe["wrong"] == "That passphrase does not open this key."


def test_ordinary_tax_text_is_left_alone(probe):
    assert "[" not in probe["plain"]["text"]


def test_labelled_people_and_birth_dates_are_hidden(probe):
    text = probe["labelled"]["text"]
    for s in ["Priya", "Raman", "Iyer", "Thomas", "O'Neil", "Aarav", "2016-05-02", "123-45-6789", "77 Linden", "11215"]:
        assert s not in text, s
    assert "Child 1:" in text  # the label stays


def test_greeting_names_and_businesses_are_hidden_but_not_places(probe):
    text = probe["people"]["text"]
    for s in ["Sarah", "Jennifer", "Lopez", "Michael", "Chen", "Acme", "303.555.0199", "80202"]:
        assert s not in text, s
    assert ", CO [ZIP-" in text  # a state code is not a name
    assert "[PERSON-" in text and "[BUSINESS-1]" in text


def test_a_client_list_makes_every_client_a_known_person(probe):
    assert ["Kofi", "Ostfeather"] in probe["clients"] and ["Dev", "Vaskberg"] in probe["clients"] and ["", "Raman-Iyer"] in probe["clients"]
    assert "Kofi Ostfeather" in probe["rareWithout"]
    assert probe["rareWith"] == "Can you look at the 1099 for [PERSON-1]? [PERSON-2] called. Mrs. [PERSON-3] sent the K-1."


def test_card_numbers_are_checked_and_routing_numbers_kept(probe):
    assert probe["cards"] == "Paid with [CARD-1]; the other card 4111-1111-1111-1112 was declined. Routing 021000021."


def _key_holds_no_value(locked, secrets):
    """A saved key, judged as an attacker without the passphrase would read it: its readable fields
    hold no value, and its ciphertext, decoded, holds none either. (Searching the base64 text
    itself would find a short word like "Kip" in random ciphertext now and then.)"""
    import base64
    f = json.loads(locked)
    assert set(f) == {"format", "version", "cipher", "kdf", "iterations", "salt", "iv", "data"}, set(f)
    readable = json.dumps({k: v for k, v in f.items() if k not in ("salt", "iv", "data")}).lower()
    raw = b"".join(base64.b64decode(f[k]) for k in ("salt", "iv", "data"))
    for s in secrets:
        assert s.lower() not in readable, s
        assert s.encode("utf-8") not in raw and s.encode("utf-16-le") not in raw, s
