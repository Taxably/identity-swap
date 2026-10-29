"""The identity swap page reads a firm's own work folder for the people in it, not for its headings.

A folder of task subfolders ("Entity Formation", "Nirav Assignment Remediation", "Raw Source
Exports"), contracts that call a party "the Company", markdown tables and acronyms once came back
with "Entity", "Assignment", "Agreement", "Liability", "Pdf" and "President" swapped thousands of
times. web/'s finding runs in node over a folder shaped like that one
(identity_swap_workfolder_probe.js, invented people only). What is held:

  * a subfolder named for a task is not a client, even beside one that is ("Halvorsby, Corwin"):
    its words are everyday words of the folder, or not names at all
  * a contract's own words are no business: "the Company", "PER LLC", "Because Company", a
    sentence before "The Company", "Limited Liability Company", "Designated Activity Company";
    a document's title before the business ("OPERATING AGREEMENT OF ...") stays as printed and
    only the business's own name changes
  * acronyms ("IP", "HTML", "PRs"), Roman numerals ("VIII"), products in CamelCase ("OneDrive"),
    roles ("President", "Tax Intern") and a building named for a person are never people
  * a markdown table is read cell by cell, so a person in one cell is found and the next cell's
    words are left alone; a first name and a surname alone in a cell are a person
  * a word swapped only inside names is counted only there, so the review's count is what will
    really change
  * a business printed in a font that carries only its own letters still gets a stand-in

Skipped where node is absent.
"""

import json
import os
import re
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_workfolder_probe.js")

HEADING_WORDS = {"Entity", "Formation", "Nirav", "Assignment", "Remediation", "Raw", "Source", "Exports", "Resolved",
                 "Items", "Log", "Build", "Scripts", "Foreign", "Qualification", "Ip", "Filings", "Html", "Governance",
                 "Supporting", "Schedules", "Download", "Archive", "Repo", "Hygiene", "Board", "Id", "President",
                 "Intern", "Part", "Viii", "Deadline", "Prs", "Content", "Fencing", "Whitelisting", "Google",
                 "Onedrive", "Word", "Macintosh", "John", "Townsend", "Reauired", "Processina", "Avoid", "Delays",
                 "Operating", "Agreement", "Liability", "Terms", "Between", "Directors", "Exercise", "Repurchase",
                 "Option", "Indemnity", "Indemnitee", "Transfer", "Practice", "Because", "Will", "Run", "What",
                 "Municipality", "Fees", "Apply", "Per", "Designated", "Activity", "Statutory", "Public", "Benefit",
                 "Second", "Employer", "Open", "Checklist", "Microsoft", "Drive"}


@pytest.fixture(scope="module")
def probe():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed - the page's rules cannot be run here")
    r = subprocess.run([node, PROBE], capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _found(probe):
    return {i["display"]: i for i in probe["items"] if i["kind"] in ("name", "business")}


def _line(probe, start):
    k = next(n for n, b in enumerate(probe["before"]) if b.startswith(start))
    return probe["before"][k], probe["after"][k]


def test_a_folder_named_for_a_task_is_not_a_client(probe):
    assert probe["clients"] == ["Halvorsby, Corwin"]


def test_no_heading_contract_word_or_acronym_is_taken_for_a_name(probe):
    wrong = sorted(HEADING_WORDS & set(_found(probe)))
    assert not wrong, "taken for names or businesses: %s" % ", ".join(wrong)


def test_the_people_and_businesses_in_the_folder_are_found(probe):
    found = _found(probe)
    for name in ("Corwin", "Halvorsby", "Delphine", "Achterberg", "Briskwater", "Thornquist"):
        assert name in found and found[name]["replacement"], name


def test_a_contract_keeps_its_own_words(probe):
    for start in ("A Limited Liability Company", "TERMS OF AN AGREEMENT", "1. Directors.", "2. Exercise", "3. Indemnity",
                  "4. Transfer.", "5. Practice.", "Because Company", "PAYMENT WILL BE RUN", "WHAT THE COMPANY",
                  "MUNICIPALITY FEES", "Designated Activity Company", "Formation Statutory", "PART VIII", "Repo | Open PRs",
                  "IP Fencing", "Google Drive", "HTML Exports", "Mail it to the John G. Townsend Building",
                  "Items Reauired", "| Board | Id | Items |", "| Resolved Items Log |"):
        before, after = _line(probe, start)
        assert before == after, "%r became %r" % (before, after)


def test_only_the_business_name_changes_after_a_document_title(probe):
    before, after = _line(probe, "OPERATING AGREEMENT OF")
    assert after.startswith("OPERATING AGREEMENT OF ") and after.endswith(" LLC")
    assert "BRISKWATER" not in after and "HOLLOW" not in after


def test_people_in_a_table_and_beside_a_role_are_swapped_and_the_role_stays(probe):
    before, after = _line(probe, "**Corwin Halvorsby**, President")
    assert "Corwin" not in after and "Halvorsby" not in after and "Delphine" not in after and "Achterberg" not in after
    assert re.fullmatch(r"\*\*\w+ \w+\*\*, President \| \*\*\w+ \w+\*\*", after), after
    before, after = _line(probe, "Delphine Achterberg (Tax Intern)")
    assert after.endswith(" (Tax Intern)") and "Delphine" not in after


def test_ordinary_lowercase_text_is_left_alone(probe):
    for start in ("the entity formation", "the open items", "exports from the raw source", "a log of the items",
                  "a foreign qualification", "governance remediation", "supporting schedules", "repo hygiene"):
        before, after = _line(probe, start)
        assert before == after, "%r became %r" % (before, after)


def test_a_word_swapped_only_inside_a_name_is_counted_only_there(probe):
    found = _found(probe)
    assert found["Tile"]["mode"] == "inside names only"
    assert found["Tile"]["count"] == 1


def test_a_subset_font_still_gets_a_stand_in_from_its_own_letters(probe):
    sub = probe["subset"]
    assert sub["replacement"] and sub["replacement"] != sub["display"]
    assert sorted(sub["replacement"].lower()) == sorted(sub["display"].lower())
