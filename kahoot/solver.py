"""Answer solver – searches the Kahoot public quiz database to find
matching quizzes and extract correct answers."""

import json
import re
from typing import Optional

import requests

SEARCH_URL = "https://create.kahoot.it/rest/kahoots/"


def search_quizzes(query: str, limit: int = 5) -> list[dict]:
    """Search the public Kahoot quiz database and return matching quizzes."""
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
        resp = requests.get(SEARCH_URL, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return data.get("entities", [])
    except Exception:
        return []


def fetch_quiz_details(uuid: str) -> Optional[dict]:
    """Fetch full quiz details including questions and correct answers."""
    url = f"https://create.kahoot.it/rest/kahoots/{uuid}"
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def extract_answers(quiz: dict) -> list[dict]:
    """Extract questions and their correct answer indices from a quiz."""
    results = []
    for q in quiz.get("questions", []):
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
        })
    return results


class QuizSolver:
    """Caches quiz answers and tries to match incoming questions to find
    the correct answer automatically."""

    def __init__(self):
        self.quiz_answers: list[dict] = []
        self.current_quiz_id: Optional[str] = None

    def load_quiz_by_search(self, search_term: str) -> bool:
        """Search for a quiz and load the first match's answers."""
        quizzes = search_quizzes(search_term)
        if not quizzes:
            return False

        # Try each result until we get one with questions
        for quiz_summary in quizzes:
            uuid = quiz_summary.get("card", {}).get("uuid") or quiz_summary.get("uuid")
            if not uuid:
                continue
            quiz = fetch_quiz_details(uuid)
            if quiz and quiz.get("questions"):
                self.quiz_answers = extract_answers(quiz)
                self.current_quiz_id = uuid
                return True
        return False

    def load_quiz_by_id(self, uuid: str) -> bool:
        """Load answers for a specific quiz UUID."""
        quiz = fetch_quiz_details(uuid)
        if not quiz:
            return False
        self.quiz_answers = extract_answers(quiz)
        self.current_quiz_id = uuid
        return True

    def find_answer(self, question_index: int, question_text: str = "",
                    num_choices: int = 4) -> Optional[int]:
        """Try to find the correct answer for a question.

        Strategy:
        1. Match by question index (if quiz is loaded in order)
        2. Match by question text similarity
        3. Return None if no match found
        """
        # Strategy 1: direct index match
        if question_index < len(self.quiz_answers):
            entry = self.quiz_answers[question_index]
            if entry["correct"]:
                return entry["correct"][0]

        # Strategy 2: text matching
        if question_text:
            best_match = None
            best_score = 0
            clean_q = _normalize(question_text)
            for entry in self.quiz_answers:
                score = _similarity(clean_q, _normalize(entry["question"]))
                if score > best_score:
                    best_score = score
                    best_match = entry
            if best_match and best_score > 0.5 and best_match["correct"]:
                return best_match["correct"][0]

        return None

    def get_loaded_questions(self) -> list[dict]:
        return self.quiz_answers


def _normalize(text: str) -> str:
    """Normalize text for comparison."""
    text = re.sub(r"<[^>]+>", "", text)  # strip HTML tags
    text = re.sub(r"[^\w\s]", "", text.lower())
    return " ".join(text.split())


def _similarity(a: str, b: str) -> float:
    """Simple word-overlap similarity score between 0 and 1."""
    if not a or not b:
        return 0.0
    words_a = set(a.split())
    words_b = set(b.split())
    if not words_a or not words_b:
        return 0.0
    intersection = words_a & words_b
    return len(intersection) / max(len(words_a), len(words_b))
