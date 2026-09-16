import base64
import hashlib
import hmac
import json
import secrets
import time

from .models import Snapshot


class SnapshotSigner:
    def __init__(self, key: str):
        self.key = (key or secrets.token_urlsafe(48)).encode()

    def sign(self, snapshot: Snapshot) -> str:
        data = base64.urlsafe_b64encode(snapshot.model_dump_json().encode()).decode()
        signature = hmac.new(self.key, data.encode(), hashlib.sha256).hexdigest()
        return data + "." + signature

    def verify(self, token: str) -> Snapshot:
        try:
            data, signature = token.rsplit(".", 1)
            expected = hmac.new(self.key, data.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature):
                raise ValueError("Invalid signature")
            result = Snapshot.model_validate(json.loads(base64.urlsafe_b64decode(data)))
            if time.time() - result.issued_at > 7 * 86400:
                raise ValueError("Expired snapshot")
            return result
        except Exception as error:
            raise ValueError("저장된 검색의 서버 인증이 만료되었습니다. 새 검색을 실행하세요.") from error
