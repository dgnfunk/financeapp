import pytest

from app.services.documents import parse_csv, parse_xml_cfdi, sniff_kind


def test_sniffs_supported_content() -> None:
    assert sniff_kind(b"%PDF-1.7\n") == "pdf"
    assert sniff_kind(b"fecha,importe\n2026-08-18,42\n") == "csv"


def test_rejects_executable_disguised_as_document() -> None:
    with pytest.raises(ValueError):
        sniff_kind(b"MZ executable")


def test_parses_csv_deterministically() -> None:
    parsed = parse_csv(b"fecha,importe\n2026-08-18,42.50\n")
    assert parsed["row_count"] == 1
    assert parsed["rows"][0]["importe"] == "42.50"


def test_cfdi_disables_external_entities() -> None:
    xml = (
        b'<cfdi:Comprobante xmlns:cfdi="urn:cfdi" Fecha="2026-08-18" Total="430.00" Moneda="MXN" />'
    )
    parsed = parse_xml_cfdi(xml)
    assert parsed["total"] == "430.00"
