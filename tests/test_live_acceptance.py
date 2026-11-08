"""Explicit live business acceptance: deployed application and configured real providers."""
import os
import uuid
from urllib.parse import urlparse

import httpx
import pytest

pytestmark = pytest.mark.acceptance


def test_grounded_answer_replay_media_and_visitor_retirement():
    names = [
        'GUIDE_ACCEPTANCE_ORIGIN', 'GUIDE_ACCEPTANCE_QUESTION', 'GUIDE_ACCEPTANCE_SOURCE',
        'GUIDE_ACCEPTANCE_TEXT', 'GUIDE_ACCEPTANCE_ASSET_ID',
        'GUIDE_ACCEPTANCE_FOLLOWUP_QUESTION', 'GUIDE_ACCEPTANCE_FOLLOWUP_TEXT',
        'GUIDE_ACCEPTANCE_FOLLOWUP_SOURCE',
    ]
    missing = [name for name in names if not os.getenv(name, '').strip()]
    assert not missing, '真实验收缺少配置：' + ', '.join(missing)
    origin = os.environ['GUIDE_ACCEPTANCE_ORIGIN'].rstrip('/')
    assert urlparse(origin).scheme in {'http', 'https'}, 'GUIDE_ACCEPTANCE_ORIGIN 必须是 HTTP URL'
    visitor = 'acceptance-' + uuid.uuid4().hex
    body = {'visitor_id':visitor, 'turn_id':'first', 'turn_seq':1, 'question':os.environ['GUIDE_ACCEPTANCE_QUESTION']}
    with httpx.Client(timeout=90, trust_env=False) as client:
        assert client.get(origin + '/health').json() == {'status':'ok'}
        config = client.get(origin + '/ui-config')
        assert config.status_code == 200 and set(config.json()) == {'avatar_id','tts_voice'}
        try:
            response = client.post(origin + '/questions', json=body)
            assert response.status_code == 200, f'问答失败 HTTP {response.status_code}'
            result = response.json()
            assert result['status'] == 'answer' and result.get('error_code') is None and result['sources']
            assert os.environ['GUIDE_ACCEPTANCE_TEXT'] in result['text'], '首轮回答未包含预期事实片段'
            assert any(source['source'].get('filename') == os.environ['GUIDE_ACCEPTANCE_SOURCE'] and source['excerpt'].strip() for source in result['sources'])
            assert client.post(origin + '/questions', json=body).json() == result
            presentation = result.get('presentation', {})
            assets = presentation.get('assets', [])
            expected_asset = os.environ['GUIDE_ACCEPTANCE_ASSET_ID']
            assert any(asset['id'] == expected_asset for asset in assets), '首轮未返回预期资料图片'
            assert any(sentence.get('asset_id') == expected_asset for sentence in presentation.get('sentences', [])), '预期资料图片未绑定到回答句子'
            for asset in assets:
                # Public asset URLs include /guide; both direct backend and proxy origins work.
                media = client.get(origin + '/media/' + asset['id'])
                assert media.status_code == 200 and media.content
                assert media.headers['content-type'].split(';')[0] == asset['mime']
            followup = client.post(origin + '/questions', json={**body, 'turn_id':'followup', 'turn_seq':2, 'question':os.environ['GUIDE_ACCEPTANCE_FOLLOWUP_QUESTION']})
            assert followup.status_code == 200
            followup_result = followup.json()
            assert followup_result['visitor_id'] == visitor and followup_result['turn_seq'] == 2
            assert followup_result['status'] == 'answer' and followup_result.get('error_code') is None
            assert os.environ['GUIDE_ACCEPTANCE_FOLLOWUP_TEXT'] in followup_result['text'], '追问回答未包含预期事实片段'
            assert any(source['source'].get('filename') == os.environ['GUIDE_ACCEPTANCE_FOLLOWUP_SOURCE'] and source['excerpt'].strip() for source in followup_result['sources']), '追问未返回预期知识来源'
        finally:
            retired = client.post(origin + f'/visitors/{visitor}/invalidate', json={'through_turn_seq':2,'retire':True})
            assert retired.status_code == 200
        late = client.post(origin + '/questions', json={**body,'turn_seq':3,'turn_id':'late'})
        assert late.status_code == 409 and late.json()['error_code'] == 'visitor_retired'
