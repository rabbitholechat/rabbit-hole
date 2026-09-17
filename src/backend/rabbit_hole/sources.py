import asyncio
import hashlib
import ipaddress
import socket
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .diagnostics import write as debug_write
from .errors import EvidenceValidationError
from .models import Answer, Evidence, Relationships, Source, utc_now

TRACKING = {"fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"}


def normalize_url(raw: str) -> str:
    if len(raw) > 4096 or any(ord(c) < 32 for c in raw):
        raise ValueError("Invalid URL")
    p = urlsplit(raw)
    if p.scheme not in {"http", "https"} or not p.hostname or p.username or p.password:
        raise ValueError("Unsafe URL")
    host = p.hostname.encode("idna").decode().lower().rstrip(".")
    if host == "localhost" or "." not in host or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Private hostname")
    try:
        if not ipaddress.ip_address(host).is_global:
            raise ValueError("Private IP")
    except ValueError as error:
        if str(error) == "Private IP":
            raise
    if p.port not in {None, 80, 443}:
        raise ValueError("Unsafe port")
    query = [
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING
    ]
    # Preserve parameter order, repeated keys and trailing slash: they can distinguish pages.
    netloc = f"[{host}]" if ":" in host else host
    if p.port and p.port != (443 if p.scheme == "https" else 80):
        netloc += f":{p.port}"
    return urlunsplit((p.scheme, netloc, p.path or "/", urlencode(query), ""))


async def public_url(raw: str) -> str:
    url = normalize_url(raw)
    host = urlsplit(url).hostname
    records = await asyncio.wait_for(
        asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM), 3
    )
    if not records or any(not ipaddress.ip_address(r[4][0]).is_global for r in records):
        raise ValueError("Non-public DNS")
    return url


class Registry:
    def __init__(self, sources: list[Source] | None = None, *, debug: bool = False, request_id: str = ""):
        self.debug = debug
        self.request_id = request_id
        self.sources = {s.id: s for s in sources or []}

    def add(self, raw: dict) -> Source:
        original = raw["url"]
        url = normalize_url(original)
        sid = "src_" + hashlib.sha256(url.encode()).hexdigest()[:24]
        if sid not in self.sources:
            self.sources[sid] = Source(
                id=sid,
                original_url=original,
                url=url,
                domain=urlsplit(url).hostname or "",
                title=str(raw.get("title") or url)[:400],
                summary=str(raw.get("content") or "")[:2500],
                content_origin=raw.get("content_origin", "search_snippet"),
                # Search does not guarantee publication dates. Never infer them.
                published_at=raw.get("published_date"),
                retrieved_at=utc_now(),
            )
        elif not self.sources[sid].summary and raw.get("content"):
            # A consulted URL may receive its first attributable summary on a follow-up.
            # Never overwrite existing evidence referenced by a saved answer/graph.
            source = self.sources[sid]
            source.summary = str(raw["content"])[:2500]
            source.content_origin = raw.get("content_origin", "search_snippet")
            source.title = str(raw.get("title") or source.title)[:400]
        return self.sources[sid]

    def diagnostic(self, event: str, **data):
        debug_write(self.debug, self.request_id, event, **data)

    def evidence_reason(self, evidence: Evidence) -> str | None:
        source = self.sources.get(evidence.source_id)
        if not source:
            return "unknown_source_id"
        if not evidence.quote.strip():
            return "empty_quote"
        if evidence.basis == "excerpt":
            if source.content_origin == "web_search_summary":
                return "ai_summary_as_excerpt"
            if source.read_status != "read":
                return "original_not_read"
        text = source.excerpt if evidence.basis == "excerpt" else source.summary
        if not text.strip():
            return "empty_source_text"
        if " ".join(evidence.quote.split()) not in " ".join(text.split()):
            return "quote_not_found"
        return None

    def evidence(self, evidence: Evidence, **context) -> bool:
        reason = self.evidence_reason(evidence)
        if reason:
            self.diagnostic("evidence_rejected", reason=reason, evidence=evidence.model_dump(), **context)
        return reason is None

    def reject(self, reason: str, **context) -> bool:
        self.diagnostic("validation_rejected", reason=reason, **context)
        return True

    def validate_answer(self, answer: Answer) -> Answer:
        invalid = False
        for index, claim in enumerate(answer.claims):
            if not claim.evidence:
                invalid |= self.reject("missing_evidence", stage="answer", claim_index=index)
            for ei, evidence in enumerate(claim.evidence):
                # Evaluate every item for diagnostics; do not short-circuit at the first failure.
                invalid |= not self.evidence(evidence, stage="answer", claim_index=index, evidence_index=ei)
        if invalid:
            raise EvidenceValidationError("Unsupported citation")
        return answer

    def validate_relationships(self, graph: Relationships) -> Relationships:
        invalid = False
        pairs = set()
        for index, edge in enumerate(graph.relations):
            ctx = {
                "stage": "relationships",
                "edge_index": index,
                "source_id": edge.source,
                "target_id": edge.target,
            }
            if edge.source == edge.target:
                invalid |= self.reject("self_edge", **ctx)
            if edge.source not in self.sources or edge.target not in self.sources:
                invalid |= self.reject("unknown_endpoint", **ctx)
            if not edge.evidence:
                invalid |= self.reject("missing_evidence", **ctx)
            for ei, evidence in enumerate(edge.evidence):
                invalid |= not self.evidence(evidence, evidence_index=ei, **ctx)
            if not {edge.source, edge.target}.issubset({e.source_id for e in edge.evidence}):
                invalid |= self.reject("missing_endpoint_evidence", **ctx)
            pair = tuple(sorted([edge.source, edge.target]))
            if pair in pairs:
                invalid |= self.reject("duplicate_edge", **ctx)
            pairs.add(pair)
        for index, label in enumerate(graph.page_types):
            if label.source_id not in self.sources:
                invalid |= self.reject(
                    "unknown_page_type_source",
                    stage="relationships",
                    page_type_index=index,
                    source_id=label.source_id,
                )
        assigned = set()
        for index, cluster in enumerate(graph.clusters):
            for sid in cluster.source_ids:
                if sid not in self.sources:
                    invalid |= self.reject(
                        "unknown_cluster_source", stage="relationships", cluster_index=index, source_id=sid
                    )
                if sid in assigned:
                    invalid |= self.reject(
                        "duplicate_cluster_source", stage="relationships", cluster_index=index, source_id=sid
                    )
                assigned.add(sid)
        if invalid:
            raise EvidenceValidationError("Unsupported graph evidence or structure")
        return graph
