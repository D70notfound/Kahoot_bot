"""Answer solver – searches the Kahoot public quiz database to find
matching quizzes and extract correct answers.

Strategies for finding the quiz:
1. Direct UUID lookup (if we intercepted the quiz ID from the game)
2. Challenge/PIN lookup (for async challenges)
3. Title-based search with multiple fallback APIs
4. Text-matching against loaded questions
"""

import re
from difflib import SequenceMatcher
from typing import Optional

import requests

# ─── API Endpoints ────────────────────────────────────────────────────
SEARCH_URL = "https://create.kahoot.it/rest/kahoots/"
QUIZ_DETAIL_URLS = [
    "https://create.kahoot.it/rest/kahoots/{uuid}",
    "https://play.kahoot.it/rest/kahoots/{uuid}",
]
CHALLENGE_PIN_URL = "https://kahoot.it/rest/challenges/pin/{pin}"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
}


# ─── API Functions ────────────────────────────────────────────────────
def search_quizzes(query: str, limit: int = 20) -> list[dict]:
    """Search the public Kahoot quiz database."""
    params = {
        "query": query,
        "cursor": 0,
        "limit": limit,
        "topics": "",
        "grades": "",
        "order": "relevance",
        "includeExtendedCounters": False,
    }
    try:
        resp = requests.get(SEARCH_URL, params=params, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return data.get("entities", [])
    except Exception:
        return []


def fetch_quiz_details(uuid: str) -> Optional[dict]:
    """Fetch full quiz details from multiple endpoints."""
    for url_template in QUIZ_DETAIL_URLS:
        url = url_template.format(uuid=uuid)
        try:
            resp = requests.get(url, headers=HEADERS, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("questions"):
                    return data
        except Exception:
            continue
    return None


def lookup_challenge_pin(pin: str) -> Optional[str]:
    """Try to get the quiz UUID from a challenge PIN."""
    url = CHALLENGE_PIN_URL.format(pin=pin)
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            return (
                data.get("kahootId")
                or data.get("quizId")
                or data.get("kahoot", {}).get("uuid")
            )
    except Exception:
        pass
    return None


def extract_answers(quiz: dict) -> list[dict]:
    """Extract questions and their correct answer indices from a quiz."""
    results = []
    for q in quiz.get("questions", []):
        q_type = q.get("type", "quiz")
        question_text = q.get("question", "")
        choices = q.get("choices", [])
        correct_indices = [
            i for i, c in enumerate(choices) if c.get("correct")
        ]
        choice_texts = [c.get("answer", "") for c in choices]
        results.append({
            "question": question_text,
            "choices": choice_texts,
            "correct": correct_indices,
            "type": q_type,
        })
    return results


# ─── Quiz Solver ──────────────────────────────────────────────────────
class QuizSolver:
    """Caches quiz answers and matches incoming questions to find
    the correct answer automatically."""

    def __init__(self):
        self.quiz_answers: list[dict] = []
        self.current_quiz_id: Optional[str] = None
        self.current_quiz_title: Optional[str] = None
        self._all_loaded: list[list[dict]] = []  # answers from all matching quizzes

    def load_quiz_by_search(self, search_term: str) -> bool:
        """Search for a quiz and load answers. Tries multiple strategies."""
        quizzes = search_quizzes(search_term, limit=20)
        if not quizzes:
            # Try with simplified search term
            simplified = re.sub(r"[^\w\s]", "", search_term).strip()
            if simplified and simplified != search_term:
                quizzes = search_quizzes(simplified, limit=20)

        if not quizzes:
            return False

        # Load ALL matching quizzes (not just the first)
        self._all_loaded = []
        best_quiz = None
        best_score = -1

        for quiz_summary in quizzes:
            uuid = (
                quiz_summary.get("card", {}).get("uuid")
                or quiz_summary.get("uuid")
            )
            if not uuid:
                continue

            quiz = fetch_quiz_details(uuid)
            if not quiz or not quiz.get("questions"):
                continue

            answers = extract_answers(quiz)
            self._all_loaded.append(answers)

            # Score this quiz by title similarity to search term
            title = quiz.get("title", "")
            score = _similarity_ratio(
                _normalize(search_term), _normalize(title)
            )
            if score > best_score:
                best_score = score
                best_quiz = quiz
                self.quiz_answers = answers
                self.current_quiz_id = uuid
                self.current_quiz_title = title

        return best_quiz is not None

    def load_quiz_by_id(self, uuid: str) -> bool:
        """Load answers for a specific quiz UUID."""
        quiz = fetch_quiz_details(uuid)
        if not quiz:
            return False
        self.quiz_answers = extract_answers(quiz)
        self.current_quiz_id = uuid
        self.current_quiz_title = quiz.get("title", "")
        self._all_loaded = [self.quiz_answers]
        return True

    def load_quiz_by_pin(self, pin: str) -> bool:
        """Try to load quiz from a challenge PIN."""
        uuid = lookup_challenge_pin(pin)
        if uuid:
            return self.load_quiz_by_id(uuid)
        return False

    def find_answer(self, question_index: int, question_text: str = "",
                    num_choices: int = 4) -> Optional[int]:
        """Try to find the correct answer for a question.

        Strategies (in order):
        1. Text match against all loaded quizzes (most reliable)
        2. Index match in primary quiz
        3. Index match in all loaded quizzes
        4. None if no match found
        """
        if not self.quiz_answers and not self._all_loaded:
            return None

        # Strategy 1: text matching (best for randomized questions)
        if question_text:
            result = self._match_by_text(question_text)
            if result is not None:
                return result

        # Strategy 2: direct index match in primary quiz
        if question_index < len(self.quiz_answers):
            entry = self.quiz_answers[question_index]
            if entry["correct"]:
                return entry["correct"][0]

        # Strategy 3: index match across all loaded quizzes
        for answers in self._all_loaded:
            if question_index < len(answers):
                entry = answers[question_index]
                if entry["correct"]:
                    return entry["correct"][0]

        return None

    def _match_by_text(self, question_text: str) -> Optional[int]:
        """Find answer by matching question text across all loaded quizzes."""
        clean_q = _normalize(question_text)
        if not clean_q:
            return None

        best_match = None
        best_score = 0.0

        for answers in self._all_loaded:
            for entry in answers:
                clean_e = _normalize(entry["question"])
                if not clean_e:
                    continue

                # Try multiple similarity methods
                score = max(
                    _similarity_ratio(clean_q, clean_e),
                    _word_overlap(clean_q, clean_e),
                )

                if score > best_score:
                    best_score = score
                    best_match = entry

        # Threshold for accepting a text match
        if best_match and best_score > 0.4 and best_match["correct"]:
            return best_match["correct"][0]

        return None

    def get_loaded_questions(self) -> list[dict]:
        return self.quiz_answers

    def get_status(self) -> dict:
        """Return current solver status."""
        return {
            "loaded": len(self.quiz_answers) > 0,
            "quiz_id": self.current_quiz_id,
            "quiz_title": self.current_quiz_title,
            "question_count": len(self.quiz_answers),
            "total_quizzes_loaded": len(self._all_loaded),
        }


# ─── Text Matching Helpers ────────────────────────────────────────────
def _normalize(text: str) -> str:
    """Normalize text for comparison."""
    text = re.sub(r"<[^>]+>", "", text)  # strip HTML tags
    text = re.sub(r"&\w+;", " ", text)   # strip HTML entities
    text = re.sub(r"[^\w\s]", "", text.lower())
    return " ".join(text.split())


def _similarity_ratio(a: str, b: str) -> float:
    """SequenceMatcher ratio – good for near-exact matches."""
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _word_overlap(a: str, b: str) -> float:
    """Word-overlap score – good for partial matches."""
    if not a or not b:
        return 0.0
    words_a = set(a.split())
    words_b = set(b.split())
    if not words_a or not words_b:
        return 0.0
    intersection = words_a & words_b
    return len(intersection) / max(len(words_a), len(words_b))
