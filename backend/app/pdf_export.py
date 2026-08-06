"""Shared PDF rendering + hosting for the "Email PDF" action on both
invoices and estimates: Playwright renders client-supplied HTML to a PDF,
which is uploaded to Supabase Storage and returned as a public URL. Also
holds the SSRF guard, which must not drift between the two callers.
"""
import asyncio
import ipaddress
import os
import socket
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from playwright.async_api import async_playwright


def _is_blocked_address(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # unparseable -> fail closed
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


async def _is_blocked_host(hostname: Optional[str]) -> bool:
    """SSRF guard for the Chromium instance below: it renders client-supplied
    HTML with network access enabled (needed for a business's logo_url, the
    only legitimate external fetch the HTML templates embed) - without this,
    any authenticated business could point an <img> at an internal service or
    cloud metadata endpoint (e.g. 169.254.169.254) and have the response
    rendered straight into the returned PDF."""
    if not hostname:
        return True
    try:
        # Resolving here (rather than just regexing the URL string) also
        # blocks a hostname that merely *resolves* to a private/link-local
        # address, not just a literal IP in the URL.
        infos = await asyncio.to_thread(socket.getaddrinfo, hostname, None)
    except socket.gaierror:
        return True  # can't resolve -> fail closed
    return any(_is_blocked_address(info[4][0]) for info in infos)


async def _block_private_network_requests(route) -> None:
    url = route.request.url
    if url.startswith(("data:", "about:", "blob:")):
        await route.continue_()
        return
    hostname = urlparse(url).hostname
    if await _is_blocked_host(hostname):
        await route.abort()
    else:
        await route.continue_()


async def render_and_upload_pdf(html: str, business_id: str, object_id: str) -> str:
    """Render `html` to a PDF via a sandboxed headless Chromium (SSRF-guarded),
    upload it to the shared Supabase Storage bucket under
    `<business_id>/<object_id>.pdf`, and return its public URL.

    `object_id` must be a value with no user-controlled content (e.g. a
    database-generated UUID) - it becomes part of a shared public bucket's
    object path, and a tenant-settable field (like an invoice/estimate
    number, which is influenced by the unsanitized Business.invoice_prefix/
    estimate_prefix) could otherwise inject "/" or "../" into that path.
    """
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            page = await browser.new_page()
            await page.route("**/*", _block_private_network_requests)
            await page.set_content(html, wait_until="networkidle")
            pdf_bytes = await page.pdf(format="A4", print_background=True)
        finally:
            await browser.close()

    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    object_path = f"{business_id}/{object_id}.pdf"
    upload_url = f"{supabase_url}/storage/v1/object/InvoiceAI/{object_path}"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            upload_url,
            content=pdf_bytes,
            headers={
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/pdf",
                "x-upsert": "true",
            },
        )
    if resp.status_code >= 300:
        raise HTTPException(status_code=502, detail="Failed to upload PDF")

    return f"{supabase_url}/storage/v1/object/public/InvoiceAI/{object_path}"
