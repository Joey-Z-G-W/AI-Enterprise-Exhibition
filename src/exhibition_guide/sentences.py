"""Lossless natural sentence boundaries shared by answer and presentation contracts."""

def split_sentences(text: str) -> list[str]:
    # Keep whitespace/closing punctuation verbatim; a decimal point is not a boundary.
    result, start, index = [], 0, 0
    while index < len(text):
        char = text[index]
        end = char in "。！？!?" or (char == "." and not (
            index > 0 and index + 1 < len(text) and text[index - 1].isdigit() and text[index + 1].isdigit()))
        if end:
            index += 1
            while index < len(text) and text[index] in "。！？!?.\"'”’）)":
                index += 1
            result.append(text[start:index])
            start = index
        else:
            index += 1
    if start < len(text):
        if text[start:].strip() or not result:
            result.append(text[start:])
        else:
            result[-1] += text[start:]
    return result
