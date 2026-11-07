"""Case selection and playback receipts; generated answers alone never mark a case seen."""
from __future__ import annotations
from dataclasses import dataclass, field
import re
from pydantic import BaseModel, ConfigDict, Field


class PlaybackReceipt(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    turn_id: str = Field(min_length=1, max_length=128)
    turn_seq: int = Field(ge=1)
    sentence_ids: list[str] = Field(max_length=64)
    completed: bool = False


@dataclass
class TourMemory:
    completed_cases: set[str] = field(default_factory=set)
    angles: dict[str, set[str]] = field(default_factory=dict)
    current_case: str | None = None
    category: str | None = None


class TourPlanner:
    def __init__(self, media):
        self.media = media

    def select(self, question: str, memory: TourMemory) -> dict | None:
        cases = self.media.cases()
        if not cases:
            return None
        # Topic changes and deictic follow-ups take precedence over the generic word “case”.
        if re.search(r"(?:你们|公司|瑞卡).*(?:服务|业务|成立|地址|联系)|(?:服务范围|提供.*服务)", question):
            service = next((a for a in self.media.assets.values() if a.category == "services" and a.case_name), None)
            return {"mode": "topic", "query": f"{service.case_name}。{question}" if service else question}
        repeat = bool(re.search(r"再说一遍|再讲一遍|重复|复述|重讲", question))
        changing = bool(re.search(r"另一个|换(?:一|个|其他|成)|别的|其他.*案例|还有.*(?:案例|展厅|展会|咖啡|项目)", question))
        if re.search(r"换(?:个|一个|种|一种)角度|换一种讲法", question):
            changing = False
        followup = not changing and bool(re.search(r"这个|该(?:案例|项目)|它|这里|刚才|继续|深入|其他角度|还有.*特点", question))
        category = ("exhibition" if re.search(r"展厅|展会|展览|展位", question) else
                    "space" if re.search(r"商业空间|空间设计", question) else
                    "retail" if re.search(r"店铺|咖啡|门店", question) else
                    "office" if re.search(r"办公", question) else
                    "brand" if re.search(r"品牌.*案例", question) else
                    "film" if re.search(r"影视|视频|广告片", question) else None)
        named = [c for c in cases.values() if c["name"].casefold() in question.casefold() or
                 any(alias.casefold() in question.casefold() for alias in c.get("aliases", [])
                     if alias not in {"咖啡", "咖啡馆", "咖啡店", "办公室", "展厅", "展会", "品牌", "服务"})]
        excluded = set()
        for case in named:
            names = [case["name"], *case.get("aliases", [])]
            for name in names:
                at = question.casefold().find(name.casefold())
                if at >= 0 and re.search(r"(?:不要|除了|别再)[^，,。；;]{0,8}$", question[:at]):
                    excluded.add(case["id"])
        if excluded:
            changing = True
            followup = False
        explicit = next((c for c in named if c["id"] not in excluded), None)
        generic = not repeat and not followup and not explicit and (changing or bool(re.search(
            r"案例|项目|另一个|换一个|再介绍|再讲一个|还有哪些|还有什么|还有呢", question)))
        mode = "specific"
        selected = explicit
        if generic:
            category = category or (memory.category if memory.category in {c["category"] for c in cases.values()} | {"space"} else None) or "exhibition"
            eligible = [c for c in cases.values() if c["category"] == category or category == "space" and c["category"] in {"exhibition", "retail", "office"}]
            available = [c for c in eligible if c["id"] not in memory.completed_cases and c["id"] not in excluded
                         and not (changing and c["id"] == memory.current_case)]
            if not available:
                label = {"exhibition": "展厅与展会", "space": "商业空间", "brand": "品牌", "retail": "店铺", "office": "办公室", "film": "影视"}.get(category, category)
                return {"exhausted": f"当前已审核的{label}案例已介绍完，可以继续深入已有案例。", "category": category}
            introduced = memory.completed_cases | set(memory.angles)
            clients = {cases[c].get("client_id", c) for c in introduced if c in cases}
            available.sort(key=lambda c: c["id"] in introduced)
            selected = next((c for c in available if c.get("client_id", c["id"]) not in clients), available[0])
            mode = "generic"
        elif not selected and memory.current_case in cases and (repeat or followup):
            selected = cases[memory.current_case]
            mode = "repeat" if repeat else "followup"
        elif selected:
            mode = "repeat" if repeat else "followup" if selected["id"] == memory.current_case else "specific"
        if not selected:
            return None
        return {"case_id": selected["id"], "case_name": selected["name"], "category": category or selected["category"],
                "mode": mode, "played_angles": sorted(memory.angles.get(selected["id"], set())),
                "query": f"{selected['name']}。{question}"}
