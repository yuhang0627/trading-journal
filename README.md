# Trading Journal

Personal trading journal hosted on GitHub Pages.

## Deploy

Push to `main`, then enable GitHub Pages from:

`Settings` -> `Pages` -> `Deploy from a branch` -> `main` -> `/ (root)`

## Stack

- HTML
- CSS
- JavaScript
- Supabase

## Automation

The optional Vantage email automation lives in `automation/`.

Run `supabase-automation.sql` in Supabase, then deploy the `automation/` Node service on the VPS and connect Gmail Apps Script to its webhook.
