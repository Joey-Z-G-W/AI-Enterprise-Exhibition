"""Independent application and process health endpoint."""

from typing import Annotated

from fastapi import Depends, FastAPI, Response

from exhibition_guide.answer import AnswerService, QuestionRequest, QuestionResponse, error_response

app = FastAPI(title="Exhibition Guide")


@app.get("/health")
def health() -> dict[str, str]:
    """Report process health without checking upstream services."""
    return {"status": "ok"}


def get_answer_service() -> AnswerService | None:
    """Production retrieval/model wiring is deferred; no default fake answers."""
    return None


@app.post("/questions", response_model=QuestionResponse)
async def questions(
    request: QuestionRequest, response: Response,
    service: Annotated[AnswerService | None, Depends(get_answer_service)],
) -> QuestionResponse:
    result = (
        error_response(request, "service_not_configured")
        if service is None else await service.answer(request)
    )
    if result.status == "error":
        response.status_code = (
            503 if result.error_code == "service_not_configured"
            else 504 if result.error_code and result.error_code.endswith("_timeout") else 502
        )
    return result
