# Security

Identity Swap handles clients' tax documents. A flaw that lets a real value through, or lets the
page reach the network, is a security problem, and is fixed ahead of any other work.

## Report a problem privately

Use GitHub's private reporting: the repository's **Security** tab, then **Report a
vulnerability**. Do not open a public issue for a security problem.

Include what you did, what came out, and a document that shows it, made with invented people only.
Never send a real client's document.

## What counts

- A personal value (name, SSN, EIN, address, account, ID, birth date) left in any file, text or file
  name the page or the companion delivers, after its checks passed
- Any request the page makes to any address, or a way to make it make one
- A saved key (`.swapkey`) that opens without its passphrase, or leaks a value without it
- A library inside the page that is not the file `web/build.py` pins

Finding misses that the checks catch (the file is held back, or the value is listed for review) are
ordinary bugs: open an issue with an invented example.

## Supported versions

Only the latest commit on the default branch is supported. Fixes are not back-ported.
