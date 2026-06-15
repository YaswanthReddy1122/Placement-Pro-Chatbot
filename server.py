from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from html import unescape
import base64
import io
import json
import os
import re
import ssl
import urllib.error
import urllib.request
import zipfile
import hashlib
import hmac
import mimetypes
import pymongo
from bson import ObjectId
from datetime import datetime

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
MODEL = "meta-llama/Llama-3.1-8B-Instruct"
HF_CHAT_URL = "https://router.huggingface.co/v1/chat/completions"
HF_TIMEOUT_SECONDS = 35
MAX_JSON_BYTES = 120_000
MAX_UPLOAD_BYTES = 5_000_000
JWT_SECRET = "super-secret-placement-assistant-key-1337-pro"

# Global database reference
DB = None

# Initialize database connection
def init_db():
    global DB
    mongo_uri = os.environ.get("MONGO_URI", "mongodb://localhost:27017/")
    db_name = os.environ.get("MONGO_DB_NAME", "placement_chatbot")
    
    client = pymongo.MongoClient(mongo_uri)
    try:
        # Tries to get database specified in connection string (e.g. Atlas connection string)
        DB = client.get_default_database()
    except Exception:
        DB = client[db_name]
        
    # Ensure unique email index for user accounts
    DB.users.create_index("email", unique=True)
    DB.chats.create_index("id", unique=True)

def load_env_file():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

# Custom JWT Tokens helpers (HMAC-SHA256 based)
def create_jwt(payload):
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = base64.urlsafe_b64encode(json.dumps(header).encode()).decode().rstrip("=")
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    signature = hmac.new(JWT_SECRET.encode(), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256).digest()
    signature_b64 = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    return f"{header_b64}.{payload_b64}.{signature_b64}"

def verify_jwt(token):
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        header_b64, payload_b64, signature_b64 = parts
        
        expected_sig = hmac.new(JWT_SECRET.encode(), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256).digest()
        expected_sig_b64 = base64.urlsafe_b64encode(expected_sig).decode().rstrip("=")
        
        if hmac.compare_digest(signature_b64, expected_sig_b64):
            rem = len(payload_b64) % 4
            if rem > 0:
                payload_b64 += "=" * (4 - rem)
            payload_str = base64.urlsafe_b64decode(payload_b64.encode()).decode()
            return json.loads(payload_str)
    except Exception:
        pass
    return None

def hash_password(password, salt=None):
    if not salt:
        salt = os.urandom(16).hex()
    hashed = hashlib.sha256((password + salt).encode()).hexdigest()
    return f"{salt}${hashed}"

def verify_password(password, stored_hash):
    try:
        salt, hashed = stored_hash.split("$")
        check = hashlib.sha256((password + salt).encode()).hexdigest()
        return hmac.compare_digest(check, hashed)
    except Exception:
        return False

# Prompt Generators
def placement_system_prompt():
    return (
        "You are AI Placement Assistant Pro, an advanced, highly professional "
        "placement preparation mentor. Help students with ATS resumes, coding "
        "rounds, interview tactics, and roadmaps. Maintain a premium, executive "
        "tone. Provide concise, expert suggestions. Never suggest cheating."
    )

def resume_prompt(resume_text):
    return (
        "You are an expert ATS Resume Auditor.\n\n"
        "Critically evaluate this resume text and respond with a structured assessment.\n\n"
        "1. Overall Resume Score: [Number 0-100]\n"
        "2. ATS Compatibility Score: [Number 0-100]\n"
        "3. Strengths: [Provide list]\n"
        "4. Weaknesses: [Provide list]\n"
        "5. Missing Placement Skills: [Skills needed for current markets]\n"
        "6. Recommended Roadmap improvements: [Detailed actionable checklist]\n\n"
        f"Resume Content:\n{resume_text[:14000]}"
    )

def interview_system_prompt():
    return (
        "You are a technical recruiter conducting a placement interview. "
        "Ask exactly one clear, targeted question at a time. Evaluate "
        "responses on communication, logic, and depth. End when asked to "
        "generate the report. At the end, output overall score, communication score, "
        "technical score, and suggestions."
    )

def readiness_prompt(profile):
    return (
        "Evaluate the student's placement readiness and probability. "
        "Provide: Placement Readiness Score (0-100), Placement Probability (Low/Medium/High), "
        "Dream Companies, Moderate Companies, Safe Companies, and a specific timeline roadmap. "
        f"Student Profile details:\n{json.dumps(profile, indent=2)}"
    )

def resume_generator_prompt(resume_data):
    return (
        "Generate a professional, ATS-optimized text resume layout based on these details. "
        "Refine work descriptions using executive action verbs. "
        f"Profile details:\n{json.dumps(resume_data, indent=2)}"
    )

def coding_evaluation_prompt(challenge, code, language):
    return (
        f"Analyze this code submission for the challenge '{challenge['title']}' written in {language}.\n"
        f"Problem Description: {challenge['description']}\n\n"
        f"User's Code:\n```\n{code}\n```\n\n"
        "Provide a comprehensive, senior engineering review in markdown, containing:\n"
        "1. Correctness: Evaluate if the solution is logically sound.\n"
        "2. Time Complexity: Calculate in Big O notation.\n"
        "3. Space Complexity: Calculate in Big O notation.\n"
        "4. Critical Optimization & Improvements: How it can be optimized.\n"
        "5. Refactored Solution: Provide the most optimal, production-ready implementation."
    )

# Static Mock Data
CODING_CHALLENGES = [
    {
        "id": "two-sum",
        "title": "Two Sum",
        "difficulty": "Easy",
        "category": "Arrays & Hashing",
        "description": "Given an array of integers `nums` and an integer `target`, return indices of the two numbers such that they add up to `target`. You may assume that each input would have exactly one solution, and you may not use the same element twice.",
        "starter_code": {
            "python": "def twoSum(nums, target):\n    # Write your code here\n    pass",
            "javascript": "function twoSum(nums, target) {\n    // Write your code here\n}",
            "cpp": "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        \n    }\n};",
            "java": "class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        \n    }\n}"
        }
    },
    {
        "id": "reverse-linked-list",
        "title": "Reverse Linked List",
        "difficulty": "Easy",
        "category": "Linked Lists",
        "description": "Given the `head` of a singly linked list, reverse the list, and return the reversed list.",
        "starter_code": {
            "python": "def reverseList(head):\n    # Write your code here\n    pass",
            "javascript": "function reverseList(head) {\n    // Write your code here\n}",
            "cpp": "class Solution {\npublic:\n    ListNode* reverseList(ListNode* head) {\n        \n    }\n};",
            "java": "class Solution {\n    public ListNode reverseList(ListNode head) {\n        \n    }\n}"
        }
    },
    {
        "id": "longest-substring",
        "title": "Longest Substring Without Repeating Characters",
        "difficulty": "Medium",
        "category": "Sliding Window",
        "description": "Given a string `s`, find the length of the longest substring without repeating characters.",
        "starter_code": {
            "python": "def lengthOfLongestSubstring(s):\n    # Write your code here\n    pass",
            "javascript": "function lengthOfLongestSubstring(s) {\n    // Write your code here\n}",
            "cpp": "class Solution {\npublic:\n    int lengthOfLongestSubstring(string s) {\n        \n    }\n};",
            "java": "class Solution {\n    public int lengthOfLongestSubstring(String s) {\n        \n    }\n}"
        }
    },
    {
        "id": "lru-cache",
        "title": "LRU Cache",
        "difficulty": "Hard",
        "category": "Design",
        "description": "Design a data structure that follows the constraints of a Least Recently Used (LRU) cache. Implement the `LRUCache` class with `get` and `put` operations in O(1) time complexity.",
        "starter_code": {
            "python": "class LRUCache:\n    def __init__(self, capacity: int):\n        pass\n    def get(self, key: int) -> int:\n        return -1\n    def put(self, key: int, value: int) -> None:\n        pass",
            "javascript": "class LRUCache {\n    constructor(capacity) {}\n    get(key) {}\n    put(key, value) {}\n}",
            "cpp": "class LRUCache {\npublic:\n    LRUCache(int capacity) {}\n    int get(int key) {}\n    void put(int key, int value) {}\n};",
            "java": "class LRUCache {\n    public LRUCache(int capacity) {}\n    public int get(int key) {}\n    public void put(int key, int value) {}\n}"
        }
    }
]

APTITUDE_QUESTIONS = {
    "quantitative": [
        {"id": 1, "question": "A can finish a work in 15 days and B can finish it in 20 days. If they work together for 4 days, what is the fraction of work left?", "options": ["7/15", "8/15", "11/15", "2/15"], "answer": "8/15", "explanation": "A's 1 day work = 1/15, B's 1 day work = 1/20. Together 1 day work = 1/15 + 1/20 = 7/60. In 4 days, work completed = 4 * 7/60 = 7/15. Work left = 1 - 7/15 = 8/15."},
        {"id": 2, "question": "A vendor bought toffees at 6 for a rupee. How many for a rupee must he sell to gain 20%?", "options": ["3", "4", "5", "6"], "answer": "5", "explanation": "Cost of 6 toffees = Rs. 1. SP of 6 toffees to gain 20% = Rs. 1.20. To gain 20%, number of toffees sold for a rupee = 6 / 1.20 = 5."},
        {"id": 3, "question": "A train passes a station platform in 36 seconds and a man standing on the platform in 20 seconds. If the speed of the train is 54 km/hr, what is the length of the platform?", "options": ["120 m", "240 m", "300 m", "360 m"], "answer": "240 m", "explanation": "Speed = 54 * 5/18 = 15 m/s. Length of train = speed * time to pass man = 15 * 20 = 300 m. Time to pass platform = (300 + Platform) / 15 = 36. Hence, 300 + Platform = 540 => Platform = 240 m."}
    ],
    "logical": [
        {"id": 1, "question": "Look at this series: 2, 1, (1/2), (1/4), ... What number should come next?", "options": ["(1/3)", "（1/8)", "（2/8)", "（1/16)"], "answer": "（1/8)", "explanation": "This is a division series; each number is half of the previous number. 1/4 divided by 2 is 1/8."},
        {"id": 2, "question": "Pointing to a photograph, Zach said, 'She is the daughter of my grandfather's only son.' How is the woman in the photograph related to Zach?", "options": ["Sister", "Mother", "Aunt", "Cousin"], "answer": "Sister", "explanation": "Grandfather's only son is Zach's father. Father's daughter is Zach's sister."},
        {"id": 3, "question": "Choose the word that does not belong with the others in the group.", "options": ["Parsley", "Basil", "Dill", "Mayonnaise"], "answer": "Mayonnaise", "explanation": "Parsley, basil, and dill are herbs. Mayonnaise is a condiment dressing."}
    ],
    "verbal": [
        {"id": 1, "question": "Identify the word that is closest in synonym to: CANDID", "options": ["Vague", "Frank", "Deceitful", "Cautious"], "answer": "Frank", "explanation": "Candid means truthful, straightforward, or frank."},
        {"id": 2, "question": "Select the correct sentence formulation:", "options": ["Every student must bring their own laptops.", "Every student must bring his or her own laptop.", "Every students must bring their own laptop.", "Every student must bring their own laptop."], "answer": "Every student must bring his or her own laptop.", "explanation": "'Every' is singular, so it requires singular pronoun modifiers 'his or her' and singular noun 'laptop'."},
        {"id": 3, "question": "Fill in the blank: The company's profits increased ______ the introduction of the new AI tools.", "options": ["due to", "in spite of", "regardless of", "subsequent to"], "answer": "subsequent to", "explanation": "'Subsequent to' means after or following, which fits grammatically and logically."}
    ]
}

COMPANY_PREP_DATA = {
    "tcs": {
        "name": "TCS (Tata Consultancy Services)",
        "hiring_process": "1. TCS NQT (National Qualifier Test) - Quant, Verbal, Logical, & 2 Coding Questions.\n2. Technical Interview - Focuses on core DSA, OOPs, DBMS, and projects.\n3. MR & HR Interview - Behavioral questions, company values, relocation queries.",
        "questions": [
            {"q": "What is the difference between Method Overloading and Overriding?", "a": "Overloading occurs at compile-time within the same class (same name, different arguments). Overriding occurs at runtime in a child class (same name, same arguments)."},
            {"q": "Explain normalization in databases and why it is useful.", "a": "Normalization organizes data to reduce redundancy and improve data integrity (1NF, 2NF, 3NF)."}
        ],
        "strategy": "Practice aptitude topics on time and speed, write simple string/array manipulation algorithms in Python/Java, and review database normal forms."
    },
    "infosys": {
        "name": "Infosys",
        "hiring_process": "1. Online Assessment - Logic, Math, Verbal, and HackwithInfy Coding Challenges.\n2. Technical & HR Round - Discussion on project architecture, cloud concepts, and resume credentials.",
        "questions": [
            {"q": "What are the four pillars of Object-Oriented Programming?", "a": "Encapsulation, Inheritance, Polymorphism, and Abstraction."},
            {"q": "What is a primary key and foreign key relation?", "a": "A primary key uniquely identifies a row in a table. A foreign key links a column to the primary key of another table to maintain relationships."}
        ],
        "strategy": "Revise OOP rules thoroughly, practice medium SQL join queries, and make sure your projects list clear individual contributions."
    },
    "amazon": {
        "name": "Amazon",
        "hiring_process": "1. Online Coding Assessment (2 DSA Challenges) + Work Style Assessment.\n2. Technical Loop (3-4 rounds) - Heavy focus on DSA, system design, and Leadership Principles.",
        "questions": [
            {"q": "Explain the difference between SQL and NoSQL databases.", "a": "SQL databases are relational, table-based, and scale vertically. NoSQL databases are non-relational, document/key-value based, and scale horizontally."},
            {"q": "How do you implement a Queue using Stacks?", "a": "Use two stacks. Push elements into stack1. To pop, if stack2 is empty, move all elements from stack1 to stack2, then pop from stack2."}
        ],
        "strategy": "Deeply study Amazon's 16 Leadership Principles and prepare STAR-method stories for each. Practice LeetCode Medium/Hard graphs, trees, and heaps."
    },
    "microsoft": {
        "name": "Microsoft",
        "hiring_process": "1. Online Codility Test - 3 DSA tasks.\n2. Technical Rounds - System architecture, pointers, memory design, recursive algorithms.\n3. AA (As Appropriate) Round - Senior manager check for cultural alignment.",
        "questions": [
            {"q": "What is memory leakage and how do you prevent it?", "a": "Memory leakage is heap memory allocated but not deallocated. Prevent it using smart pointers or strict garbage collection tracking."},
            {"q": "How does a garbage collector work in Java/C#?", "a": "It automatically identifies unreferenced heap objects and reclaims their storage."}
        ],
        "strategy": "Focus on system code correctness. Practice writing complete code structures on paper. Master linked lists, trees, tries, and low-level system design."
    }
}

class PlacementChatHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            self.send_json({"ok": True, "model": MODEL})
            return
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        # Unprotected Auth Paths
        if self.path == "/api/auth/signup":
            self.handle_signup()
            return
        if self.path == "/api/auth/login":
            self.handle_login()
            return
        if self.path == "/api/auth/forgot-password":
            self.handle_forgot_password()
            return
        if self.path == "/api/auth/reset-password":
            self.handle_reset_password()
            return

        # Authenticate all other endpoints
        user = self.require_auth()
        if not user:
            return

        if self.path == "/api/auth/profile":
            self.handle_profile(user)
            return
        if self.path == "/api/chat":
            self.handle_chat(user)
            return
        if self.path == "/api/chats/manage":
            self.handle_chats_manage(user)
            return
        if self.path == "/api/resume-analyze":
            self.handle_resume_analyze(user)
            return
        if self.path == "/api/interview":
            self.handle_interview(user)
            return
        if self.path == "/api/readiness":
            self.handle_readiness(user)
            return
        if self.path == "/api/generate-resume":
            self.handle_generate_resume(user)
            return
        if self.path == "/api/export-resume":
            self.handle_export_resume()
            return
        if self.path == "/api/upload-file":
            self.handle_file_upload()
            return
        if self.path == "/api/analyze-image":
            self.handle_image_analysis()
            return
        if self.path == "/api/analyze-document":
            self.handle_document_analysis()
            return
        if self.path == "/api/export-chat":
            self.handle_export_chat()
            return
        if self.path == "/api/coding/challenges":
            self.handle_coding_challenges()
            return
        if self.path == "/api/coding/submit":
            self.handle_coding_submit(user)
            return
        if self.path == "/api/aptitude/questions":
            self.handle_aptitude_questions()
            return
        if self.path == "/api/aptitude/submit":
            self.handle_aptitude_submit(user)
            return
        if self.path == "/api/company/prep":
            self.handle_company_prep()
            return
        if self.path == "/api/analytics":
            self.handle_analytics(user)
            return
        if self.path == "/api/reports":
            self.handle_reports(user)
            return

        self.send_json({"error": "Not found"}, status=404)

    def get_token(self):
        token = os.environ.get("HF_TOKEN")
        if not token:
            raise ValueError("HF_TOKEN is missing. Add it to .env or your environment.")
        return token

    def require_auth(self):
        auth_header = self.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            self.send_json({"error": "Missing or invalid token"}, status=401)
            return None
        token = auth_header.split(" ", 1)[1]
        user = verify_jwt(token)
        if not user:
            self.send_json({"error": "Token expired or invalid"}, status=401)
            return None
        return user

    # Auth logic
    def handle_signup(self):
        try:
            body = self.read_json_body()
            name = str(body.get("name", "")).strip()
            email = str(body.get("email", "")).strip().lower()
            password = str(body.get("password", "")).strip()
            branch = str(body.get("branch", "")).strip()
            cgpa = str(body.get("cgpa", "")).strip()
            skills = str(body.get("skills", "")).strip()
            
            if not name or not email or not password:
                self.send_json({"error": "Name, email, and password are required"}, status=400)
                return
                
            pw_hash = hash_password(password)
            
            try:
                user_doc = {
                    "name": name,
                    "email": email,
                    "password_hash": pw_hash,
                    "branch": branch,
                    "cgpa": cgpa,
                    "skills": skills,
                    "profile_photo": "",
                    "created_at": datetime.utcnow()
                }
                DB.users.insert_one(user_doc)
                self.send_json({"success": True, "message": "Sign up successful. Please log in."})
            except pymongo.errors.DuplicateKeyError:
                self.send_json({"error": "Email already registered"}, status=409)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def handle_login(self):
        try:
            body = self.read_json_body()
            email = str(body.get("email", "")).strip().lower()
            password = str(body.get("password", "")).strip()
            
            if not email or not password:
                self.send_json({"error": "Email and password are required"}, status=400)
                return
                
            user_doc = DB.users.find_one({"email": email})
            
            if not user_doc or not verify_password(password, user_doc.get("password_hash", "")):
                self.send_json({"error": "Invalid email or password"}, status=401)
                return
                
            user_data = {
                "id": str(user_doc["_id"]),
                "name": user_doc.get("name", ""),
                "email": email,
                "branch": user_doc.get("branch", ""),
                "cgpa": user_doc.get("cgpa", ""),
                "skills": user_doc.get("skills", ""),
                "profile_photo": user_doc.get("profile_photo", "")
            }
            token = create_jwt(user_data)
            self.send_json({
                "success": True,
                "token": token,
                "user": user_data
            })
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def handle_forgot_password(self):
        # Mock reset link
        body = self.read_json_body()
        email = str(body.get("email", "")).strip()
        self.send_json({
            "success": True, 
            "message": "Password recovery email mock sent.", 
            "reset_link": f"http://localhost:8000/#/reset-password?email={email}"
        })

    def handle_reset_password(self):
        try:
            body = self.read_json_body()
            email = str(body.get("email", "")).strip().lower()
            password = str(body.get("password", "")).strip()
            
            if not email or not password:
                self.send_json({"error": "Email and password are required"}, status=400)
                return
                
            user_doc = DB.users.find_one({"email": email})
            if not user_doc:
                self.send_json({"error": "User not found"}, status=404)
                return
                
            pw_hash = hash_password(password)
            DB.users.update_one({"email": email}, {"$set": {"password_hash": pw_hash}})
            self.send_json({"success": True, "message": "Password updated successfully."})
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def handle_profile(self, user):
        try:
            body = self.read_json_body()
            name = str(body.get("name", "")).strip()
            branch = str(body.get("branch", "")).strip()
            cgpa = str(body.get("cgpa", "")).strip()
            skills = str(body.get("skills", "")).strip()
            profile_photo = str(body.get("profile_photo", "")).strip()
            
            user_id = ObjectId(user["id"])
            DB.users.update_one(
                {"_id": user_id},
                {"$set": {
                    "name": name,
                    "branch": branch,
                    "cgpa": cgpa,
                    "skills": skills,
                    "profile_photo": profile_photo
                }}
            )
            
            # Fetch updated data
            row = DB.users.find_one({"_id": user_id})
            
            updated_user = {
                "id": str(row["_id"]),
                "name": row.get("name", ""),
                "email": row.get("email", ""),
                "branch": row.get("branch", ""),
                "cgpa": row.get("cgpa", ""),
                "skills": row.get("skills", ""),
                "profile_photo": row.get("profile_photo", "")
            }
            token = create_jwt(updated_user)
            self.send_json({
                "success": True,
                "token": token,
                "user": updated_user
            })
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    # Chats Manage
    def handle_chats_manage(self, user):
        try:
            body = self.read_json_body()
            action = body.get("action")
            
            if action == "list":
                rows = DB.chats.find({"user_id": user["id"]}).sort("created_at", pymongo.DESCENDING)
                chats = []
                for r in rows:
                    created_at_str = r.get("created_at")
                    if isinstance(created_at_str, datetime):
                        created_at_str = created_at_str.strftime("%Y-%m-%d %H:%M:%S")
                    chats.append({
                        "id": r["id"],
                        "title": r.get("title", ""),
                        "history": r.get("history", []),
                        "created_at": created_at_str
                    })
                self.send_json({"success": True, "chats": chats})
                
            elif action == "save":
                chat_id = body.get("id")
                title = body.get("title")
                history = body.get("history")
                
                DB.chats.update_one(
                    {"id": chat_id},
                    {
                        "$set": {
                            "user_id": user["id"],
                            "title": title,
                            "history": history
                        },
                        "$setOnInsert": {
                            "created_at": datetime.utcnow()
                        }
                    },
                    upsert=True
                )
                self.send_json({"success": True})
                
            elif action == "rename":
                chat_id = body.get("id")
                title = body.get("title")
                DB.chats.update_one(
                    {"id": chat_id, "user_id": user["id"]},
                    {"$set": {"title": title}}
                )
                self.send_json({"success": True})
                
            elif action == "delete":
                chat_id = body.get("id")
                DB.chats.delete_one({"id": chat_id, "user_id": user["id"]})
                self.send_json({"success": True})
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    # Core Module Integrations
    def handle_chat(self, user):
        try:
            token = self.get_token()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=500)
            return

        try:
            body = self.read_json_body()
            user_message = str(body.get("message", "")).strip()
            history = body.get("history", [])
            if not user_message:
                self.send_json({"error": "Message is required."}, status=400)
                return
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return

        messages = [{"role": "system", "content": placement_system_prompt()}]
        messages.extend(self.safe_history(history))
        messages.append({"role": "user", "content": user_message})

        self.send_ai_response(token, messages, max_tokens=650)

    def handle_resume_analyze(self, user):
        try:
            token = self.get_token()
            filename, file_bytes = self.read_upload("resume")
            resume_text = self.extract_resume_text(filename, file_bytes)
            if len(resume_text.strip()) < 80:
                self.send_json(
                    {
                        "error": "Could not extract enough resume text.",
                        "details": "Try a text-based PDF or DOCX resume.",
                    },
                    status=400,
                )
                return
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return

        messages = [
            {"role": "system", "content": placement_system_prompt()},
            {"role": "user", "content": resume_prompt(resume_text)},
        ]
        
        try:
            reply = self.call_hugging_face(token, {
                "model": MODEL,
                "messages": messages,
                "temperature": 0.55,
                "max_tokens": 1200,
            })
            
            # Extract scores
            resume_score = find_score_in_text(reply, ["Resume Score", "Overall Resume Score"])
            ats_score = find_score_in_text(reply, ["ATS Compatibility", "ATS Score", "ATS Compatibility Score"])
            if not resume_score or resume_score < 0:
                resume_score = 75  # Default fallback
            if not ats_score or ats_score < 0:
                ats_score = 70  # Default fallback
                
            # Log to saved_reports
            report_doc = {
                "user_id": user["id"],
                "report_type": "resume",
                "title": f"Resume Scan: {filename}",
                "content": reply,
                "score": int(resume_score),
                "created_at": datetime.utcnow()
            }
            DB.saved_reports.insert_one(report_doc)
            
            self.send_json({
                "reply": reply, 
                "model": MODEL, 
                "filename": filename, 
                "extracted_chars": len(resume_text)
            })
        except Exception as exc:
            self.send_json({"error": "Failed to analyze resume.", "details": str(exc)}, status=500)

    def handle_interview(self, user):
        try:
            token = self.get_token()
            body = self.read_json_body()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return

        mode = str(body.get("mode", "Mixed Interview")).strip() or "Mixed Interview"
        stage = str(body.get("stage", "answer")).strip()
        history = self.safe_history(body.get("history", []))

        if stage == "start":
            user_content = (
                f"Start a {mode}. Ask the first realistic campus placement "
                "interview question only. Do not provide a report yet."
            )
        elif stage == "finish":
            user_content = (
                "End the interview now and generate the final report. Include: "
                "Communication Score (0-100), Confidence Score (0-100), Technical "
                "Knowledge Score (0-100), Problem Solving Score (0-100), Overall "
                "Interview Score (0-100), Strengths, Weaknesses, Areas for "
                "Improvement, and Placement Recommendation."
            )
        else:
            answer = str(body.get("answer", "")).strip()
            if not answer:
                self.send_json({"error": "Answer is required."}, status=400)
                return
            user_content = (
                f"Candidate answer: {answer}\n\n"
                "Briefly evaluate the answer in 2-3 lines, then ask exactly one "
                "intelligent follow-up or next interview question."
            )

        messages = [{"role": "system", "content": interview_system_prompt()}]
        messages.extend(history)
        messages.append({"role": "user", "content": user_content})
        
        try:
            reply = self.call_hugging_face(token, {
                "model": MODEL,
                "messages": messages,
                "temperature": 0.65,
                "max_tokens": 1000
            })
            
            if stage == "finish":
                # Find score
                overall_score = find_score_in_text(reply, ["Overall", "Overall Interview Score"])
                if not overall_score or overall_score < 0:
                    overall_score = 80
                    
                # Log interview to database
                interview_doc = {
                    "user_id": user["id"],
                    "interview_type": mode,
                    "overall_score": int(overall_score),
                    "feedback": reply,
                    "transcript": history,
                    "created_at": datetime.utcnow()
                }
                DB.interview_attempts.insert_one(interview_doc)
                
                # Also save to saved_reports
                report_doc = {
                    "user_id": user["id"],
                    "report_type": "interview",
                    "title": f"Mock Interview: {mode}",
                    "content": reply,
                    "score": int(overall_score),
                    "created_at": datetime.utcnow()
                }
                DB.saved_reports.insert_one(report_doc)
                
            self.send_json({"reply": reply, "model": MODEL})
        except Exception as exc:
            self.send_json({"error": "Failed to run interview step.", "details": str(exc)}, status=500)

    def handle_readiness(self, user):
        try:
            token = self.get_token()
            profile = self.read_json_body()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return

        required = ["name", "branch", "cgpa", "technicalSkills", "projects"]
        missing = [key for key in required if not str(profile.get(key, "")).strip()]
        if missing:
            self.send_json(
                {"error": f"Please fill required fields: {', '.join(missing)}"},
                status=400,
            )
            return

        messages = [
            {"role": "system", "content": placement_system_prompt()},
            {"role": "user", "content": readiness_prompt(profile)},
        ]
        
        try:
            reply = self.call_hugging_face(token, {
                "model": MODEL,
                "messages": messages,
                "temperature": 0.55,
                "max_tokens": 1200
            })
            
            readiness_score = find_score_in_text(reply, ["Readiness Score", "Placement Readiness Score"])
            if not readiness_score or readiness_score < 0:
                readiness_score = 80
                
            # Log to saved_reports
            report_doc = {
                "user_id": user["id"],
                "report_type": "readiness",
                "title": "Placement Readiness Dashboard",
                "content": reply,
                "score": int(readiness_score),
                "created_at": datetime.utcnow()
            }
            DB.saved_reports.insert_one(report_doc)
            
            self.send_json({"reply": reply, "model": MODEL})
        except Exception as exc:
            self.send_json({"error": "Failed to assess readiness.", "details": str(exc)}, status=500)

    def handle_generate_resume(self, user):
        try:
            token = self.get_token()
            resume_data = self.read_json_body()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return

        if not resume_data.get("fullName") or not resume_data.get("email"):
            self.send_json({"error": "Full name and email are required."}, status=400)
            return

        messages = [
            {"role": "system", "content": placement_system_prompt()},
            {"role": "user", "content": resume_generator_prompt(resume_data)},
        ]

        try:
            reply = self.call_hugging_face(token, {
                "model": MODEL,
                "messages": messages,
                "temperature": 0.65,
                "max_tokens": 2000,
            })
            
            html = self.convert_resume_to_html(reply, resume_data)
            
            self.send_json({
                "success": True,
                "html": html,
                "fullName": resume_data.get("fullName"),
                "template": resume_data.get("template", "modern"),
                "format": resume_data.get("format", "General Placement Resume"),
            })
        except Exception as exc:
            self.send_json({"error": "Failed to generate resume.", "details": str(exc)}, status=500)

    def handle_export_resume(self):
        try:
            data = self.read_json_body()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return

        html = data.get("html", "")
        export_format = data.get("format", "pdf").lower()
        filename = data.get("filename", f"Resume.{export_format}")

        try:
            if export_format == "pdf":
                pdf_bytes = self.html_to_pdf(html)
                encoded = self.encode_base64(pdf_bytes)
            elif export_format == "docx":
                docx_bytes = self.html_to_docx(html)
                encoded = self.encode_base64(docx_bytes)
            else:
                self.send_json({"error": f"Unsupported format: {export_format}"}, status=400)
                return

            self.send_json({
                "success": True,
                "data": encoded,
                "filename": filename,
            })
        except Exception as exc:
            self.send_json({"error": "Export failed.", "details": str(exc)}, status=500)

    # Coding practices
    def handle_coding_challenges(self):
        self.send_json({"success": True, "challenges": CODING_CHALLENGES})

    def handle_coding_submit(self, user):
        try:
            token = self.get_token()
            body = self.read_json_body()
            challenge_id = body.get("challenge_id")
            code = body.get("code")
            language = body.get("language", "python")
            
            # Find the challenge
            challenge = next((c for c in CODING_CHALLENGES if c["id"] == challenge_id), None)
            if not challenge:
                self.send_json({"error": "Challenge not found"}, status=404)
                return
                
            prompt = coding_evaluation_prompt(challenge, code, language)
            
            messages = [
                {"role": "system", "content": placement_system_prompt()},
                {"role": "user", "content": prompt}
            ]
            
            feedback = self.call_hugging_face(token, {
                "model": MODEL,
                "messages": messages,
                "temperature": 0.5,
                "max_tokens": 1200
            })
            
            # Log coding submission
            submission_doc = {
                "user_id": user["id"],
                "challenge_id": challenge_id,
                "language": language,
                "code": code,
                "status": "Solved",
                "feedback": feedback,
                "created_at": datetime.utcnow()
            }
            DB.coding_submissions.insert_one(submission_doc)
            
            self.send_json({
                "success": True,
                "feedback": feedback
            })
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    # Aptitude quizzes
    def handle_aptitude_questions(self):
        # Return questions without answers
        sanitized_questions = {}
        for category, questions in APTITUDE_QUESTIONS.items():
            sanitized_questions[category] = [
                {"id": q["id"], "question": q["question"], "options": q["options"]}
                for q in questions
            ]
        self.send_json({"success": True, "questions": sanitized_questions})

    def handle_aptitude_submit(self, user):
        try:
            body = self.read_json_body()
            category = body.get("category", "quantitative")
            answers = body.get("answers", {})  # id -> answer
            
            questions = APTITUDE_QUESTIONS.get(category, [])
            score = 0
            details = []
            
            for q in questions:
                user_ans = answers.get(str(q["id"]))
                is_correct = (user_ans == q["answer"])
                if is_correct:
                    score += 1
                details.append({
                    "id": q["id"],
                    "question": q["question"],
                    "user_answer": user_ans,
                    "correct_answer": q["answer"],
                    "explanation": q["explanation"],
                    "correct": is_correct
                })
                
            # Log attempt to database
            attempt_doc = {
                "user_id": user["id"],
                "category": category,
                "score": score,
                "total": len(questions),
                "created_at": datetime.utcnow()
            }
            DB.aptitude_attempts.insert_one(attempt_doc)
            
            self.send_json({
                "success": True,
                "score": score,
                "total": len(questions),
                "details": details
            })
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    # Company prep
    def handle_company_prep(self):
        self.send_json({"success": True, "companies": COMPANY_PREP_DATA})

    # Analytics Page
    def handle_analytics(self, user):
        try:
            # 1. Coding progress (solved challenges count)
            coding_count = len(DB.coding_submissions.distinct("challenge_id", {"user_id": user["id"]}))
            
            # 2. Aptitude average score
            aptitude_rows = list(DB.aptitude_attempts.find({"user_id": user["id"]}))
            avg_aptitude = 0
            if aptitude_rows:
                avg_aptitude = sum(r.get("score", 0) / r.get("total", 1) for r in aptitude_rows) / len(aptitude_rows) * 100
                
            # 3. Latest resume score
            resume_row = DB.saved_reports.find_one(
                {"user_id": user["id"], "report_type": "resume"},
                sort=[("created_at", pymongo.DESCENDING)]
            )
            latest_resume_score = resume_row.get("score") if resume_row else None
            
            # 4. Latest readiness score
            readiness_row = DB.saved_reports.find_one(
                {"user_id": user["id"], "report_type": "readiness"},
                sort=[("created_at", pymongo.DESCENDING)]
            )
            latest_readiness_score = readiness_row.get("score") if readiness_row else None
            
            # 5. Latest mock interview score
            interview_row = DB.saved_reports.find_one(
                {"user_id": user["id"], "report_type": "interview"},
                sort=[("created_at", pymongo.DESCENDING)]
            )
            latest_interview_score = interview_row.get("score") if interview_row else None
            
            # 6. Fetch recent interview scores for history line graph
            interview_attempts = DB.interview_attempts.find({"user_id": user["id"]}).sort("created_at", pymongo.ASCENDING)
            interview_history = []
            for r in interview_attempts:
                created_at_str = r.get("created_at")
                if isinstance(created_at_str, datetime):
                    created_at_str = created_at_str.strftime("%Y-%m-%d %H:%M:%S")
                interview_history.append({
                    "score": r.get("overall_score", 0),
                    "date": created_at_str[:10] if created_at_str else ""
                })
            
            # 7. Fetch recent coding logs
            coding_attempts = DB.coding_submissions.find({"user_id": user["id"]}).sort("created_at", pymongo.DESCENDING).limit(5)
            recent_coding = []
            for r in coding_attempts:
                created_at_str = r.get("created_at")
                if isinstance(created_at_str, datetime):
                    created_at_str = created_at_str.strftime("%Y-%m-%d %H:%M:%S")
                recent_coding.append({
                    "challenge": r.get("challenge_id", ""),
                    "lang": r.get("language", ""),
                    "status": r.get("status", ""),
                    "date": created_at_str or ""
                })
            
            self.send_json({
                "success": True,
                "metrics": {
                    "coding_solved": coding_count,
                    "coding_total": len(CODING_CHALLENGES),
                    "aptitude_progress": avg_aptitude,
                    "resume_score": latest_resume_score or 0,
                    "readiness_score": latest_readiness_score or 0,
                    "interview_score": latest_interview_score or 0
                },
                "interview_history": interview_history,
                "recent_coding": recent_coding
            })
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    # Saved Reports
    def handle_reports(self, user):
        try:
            rows = DB.saved_reports.find({"user_id": user["id"]}).sort("created_at", pymongo.DESCENDING)
            reports = []
            for r in rows:
                created_at_str = r.get("created_at")
                if isinstance(created_at_str, datetime):
                    created_at_str = created_at_str.strftime("%Y-%m-%d %H:%M:%S")
                reports.append({
                    "id": str(r["_id"]),
                    "report_type": r.get("report_type", ""),
                    "title": r.get("title", ""),
                    "content": r.get("content", ""),
                    "score": r.get("score"),
                    "created_at": created_at_str
                })
            self.send_json({"success": True, "reports": reports})
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    # File and text processing helpers
    def send_ai_response(self, token, messages, max_tokens=650, extra=None):
        payload = {
            "model": MODEL,
            "messages": messages,
            "temperature": 0.55,
            "max_tokens": max_tokens,
        }

        try:
            reply = self.call_hugging_face(token, payload)
            data = {"reply": reply, "model": MODEL}
            if extra:
                data.update(extra)
            self.send_json(data)
        except urllib.error.HTTPError as exc:
            error_text = exc.read().decode("utf-8", errors="replace")
            self.send_json(
                {
                    "error": "Hugging Face request failed.",
                    "details": error_text,
                    "status": exc.code,
                },
                status=502,
            )
        except urllib.error.URLError as exc:
            self.send_json(
                {"error": "Could not reach Hugging Face.", "details": str(exc.reason)},
                status=502,
            )
        except TimeoutError:
            self.send_json(
                {
                    "error": "The model took too long to respond.",
                    "details": "Try again with shorter input.",
                },
                status=504,
            )
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=502)

    def read_json_body(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length > MAX_JSON_BYTES:
            raise ValueError("Request is too large.")
        raw_body = self.rfile.read(content_length)
        try:
            return json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("Invalid JSON.") from exc

    def read_upload(self, field_name):
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            raise ValueError("Upload must use multipart/form-data.")

        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("Upload is empty.")
        if content_length > MAX_UPLOAD_BYTES:
            raise ValueError("File is too large. Use a resume under 5 MB.")

        boundary_match = re.search(r"boundary=(?P<boundary>[^;]+)", content_type)
        if not boundary_match:
            raise ValueError("Upload boundary is missing.")

        boundary = boundary_match.group("boundary").strip('"').encode("utf-8")
        raw_body = self.rfile.read(content_length)
        delimiter = b"--" + boundary

        for part in raw_body.split(delimiter):
            if not part or part in {b"--\r\n", b"--"}:
                continue
            part = part.strip(b"\r\n")
            if b"\r\n\r\n" not in part:
                continue
            raw_headers, file_bytes = part.split(b"\r\n\r\n", 1)
            headers = raw_headers.decode("utf-8", errors="replace")
            if f'name="{field_name}"' not in headers:
                continue
            filename_match = re.search(r'filename="([^"]+)"', headers)
            filename = filename_match.group(1) if filename_match else "resume"
            return filename, file_bytes.rstrip(b"\r\n")

        raise ValueError("Resume file field is missing.")

    def extract_resume_text(self, filename, file_bytes):
        lowered = filename.lower()
        if lowered.endswith(".docx"):
            return self.extract_docx_text(file_bytes)
        if lowered.endswith(".pdf"):
            return self.extract_pdf_text(file_bytes)
        raise ValueError("Only PDF and DOCX resumes are supported.")

    def extract_docx_text(self, file_bytes):
        try:
            with zipfile.ZipFile(io.BytesIO(file_bytes)) as docx:
                xml = docx.read("word/document.xml").decode("utf-8", errors="ignore")
        except (KeyError, zipfile.BadZipFile) as exc:
            raise ValueError("Could not read DOCX resume text.") from exc

        xml = re.sub(r"</w:p>", "\n", xml)
        text = re.sub(r"<[^>]+>", " ", xml)
        return self.clean_extracted_text(unescape(text))

    def extract_pdf_text(self, file_bytes):
        decoded = file_bytes.decode("latin-1", errors="ignore")
        chunks = []

        for match in re.finditer(r"\((.*?)\)\s*Tj", decoded, re.DOTALL):
            chunks.append(match.group(1))

        for array_match in re.finditer(r"\[(.*?)\]\s*TJ", decoded, re.DOTALL):
            chunks.extend(re.findall(r"\((.*?)\)", array_match.group(1), re.DOTALL))

        if not chunks:
            chunks = re.findall(r"[A-Za-z0-9][A-Za-z0-9@#%&:;,.+\-/() ]{3,}", decoded)

        text = " ".join(self.unescape_pdf_text(chunk) for chunk in chunks)
        return self.clean_extracted_text(text)

    def unescape_pdf_text(self, text):
        text = text.replace(r"\(", "(").replace(r"\)", ")")
        text = text.replace(r"\\", "\\")
        text = re.sub(r"\\[nrt]", " ", text)
        return text

    def clean_extracted_text(self, text):
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def safe_history(self, history):
        safe_messages = []
        if not isinstance(history, list):
            return safe_messages

        for item in history[-10:]:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = str(item.get("content", "")).strip()
            if role in {"user", "assistant"} and content:
                safe_messages.append({"role": role, "content": content[:2000]})

        return safe_messages

    def call_hugging_face(self, token, payload):
        request = urllib.request.Request(
            HF_CHAT_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        ssl_context = None
        if os.environ.get("HF_VERIFY_SSL", "true").lower() == "false":
            ssl_context = ssl._create_unverified_context()

        with urllib.request.urlopen(
            request, timeout=HF_TIMEOUT_SECONDS, context=ssl_context
        ) as response:
            data = json.loads(response.read().decode("utf-8"))

        try:
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise ValueError(f"Unexpected Hugging Face response: {data}") from exc

    def convert_resume_to_html(self, resume_text, resume_data):
        name = resume_data.get("fullName", "Resume")
        email = resume_data.get("email", "")
        phone = resume_data.get("phone", "")
        linkedin = resume_data.get("linkedin", "")
        github = resume_data.get("github", "")
        portfolio = resume_data.get("portfolio", "")
        
        html = f"""
<h1>{self.escape_html(name)}</h1>
<p style="margin: 8px 0; font-size: 0.95rem;">
    {self.escape_html(email)}
    {' | ' + self.escape_html(phone) if phone else ''}
    {' | ' + (linkedin if linkedin else '') if linkedin else ''}
    {' | ' + (github if github else '') if github else ''}
    {' | ' + (portfolio if portfolio else '') if portfolio else ''}
</p>
"""
        sections = resume_text.split("\n\n")
        for section in sections:
            section = section.strip()
            if not section:
                continue
            
            lines = section.split("\n")
            first_line = lines[0].strip()
            
            if any(keyword in first_line.upper() for keyword in 
                   ["PROFESSIONAL SUMMARY", "OBJECTIVE", "SUMMARY",
                    "EXPERIENCE", "INTERNSHIP", "EDUCATION", "SKILLS",
                    "PROJECTS", "CERTIFICATIONS", "ACHIEVEMENTS", "ACTIVITIES"]):
                if lines:
                    html += f"<h2>{self.escape_html(first_line)}</h2>\n"
                    for line in lines[1:]:
                        line = line.strip()
                        if line.startswith("•") or line.startswith("-"):
                            html += f"<ul><li>{self.escape_html(line[1:].strip())}</li></ul>\n"
                        elif line:
                            html += f"<p>{self.escape_html(line)}</p>\n"
            else:
                for line in lines:
                    line = line.strip()
                    if line.startswith("•") or line.startswith("-"):
                        html += f"<ul><li>{self.escape_html(line[1:].strip())}</li></ul>\n"
                    elif line:
                        html += f"<p>{self.escape_html(line)}</p>\n"
        return html

    def escape_html(self, text):
        return (str(text)
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace('"', "&quot;")
                .replace("'", "&#039;"))

    def html_to_pdf(self, html_content):
        text = re.sub(r"<[^>]+>", "\n", html_content)
        text = re.sub(r"\n\n+", "\n", text)
        return text.encode("utf-8")

    def html_to_docx(self, html_content):
        try:
            from io import BytesIO
            import zipfile
            
            text = re.sub(r"<[^>]+>", "\n", html_content)
            text = re.sub(r"\n\n+", "\n", text)
            
            output = BytesIO()
            with zipfile.ZipFile(output, "w") as docx:
                docx.writestr("[Content_Types].xml", 
                    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                    '<Default Extension="xml" ContentType="application/xml"/>'
                    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                    '</Types>')
                
                docx.writestr("_rels/.rels",
                    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                    '</Relationships>')
                
                paragraphs = []
                for line in text.split("\n"):
                    line = line.strip()
                    if line:
                        escaped = self.escape_html(line)
                        paragraphs.append(f"<w:p><w:r><w:t>{escaped}</w:t></w:r></w:p>")
                
                doc_xml = f"""<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
{chr(10).join(paragraphs)}
</w:body>
</w:document>"""
                docx.writestr("word/document.xml", doc_xml)
            return output.getvalue()
        except Exception:
            return b"PK\x03\x04" + html_content.encode("utf-8")

    def encode_base64(self, data):
        return base64.b64encode(data).decode("utf-8")

    def handle_file_upload(self):
        try:
            filename, file_bytes = self.read_upload("file")
            file_hash = hashlib.md5(file_bytes).hexdigest()[:8]
            file_info = {
                "hash": file_hash,
                "name": filename,
                "size": len(file_bytes),
                "type": mimetypes.guess_type(filename)[0] or "application/octet-stream",
                "timestamp": datetime.now().isoformat(),
            }
            self.send_json({
                "success": True,
                "file": file_info,
                "message": f"File '{filename}' uploaded successfully.",
            })
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)

    def handle_image_analysis(self):
        try:
            token = self.get_token()
            filename, file_bytes = self.read_upload("image")
            
            image_info = {
                "filename": filename,
                "size": len(file_bytes),
                "type": mimetypes.guess_type(filename)[0],
            }
            
            prompt = (
                f"An image file has been uploaded: {filename}\n"
                f"File size: {len(file_bytes)} bytes\n\n"
                "Please analyze this image and provide:\n"
                "1. A description of what you see\n"
                "2. Any text visible in the image (OCR)\n"
                "3. Key information extracted\n"
                "4. If it's a resume screenshot, analyze its quality\n"
                "5. Recommendations for improvement if applicable"
            )
            
            messages = [
                {"role": "system", "content": placement_system_prompt()},
                {"role": "user", "content": prompt},
            ]
            
            reply = self.call_hugging_face(token, {
                "model": MODEL,
                "messages": messages,
                "temperature": 0.65,
                "max_tokens": 1000,
            })
            
            self.send_json({
                "success": True,
                "image": image_info,
                "analysis": reply,
            })
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)

    def handle_document_analysis(self):
        try:
            token = self.get_token()
            filename, file_bytes = self.read_upload("document")
            doc_text = self.extract_document_text(filename, file_bytes)
            
            if len(doc_text.strip()) < 50:
                self.send_json({
                    "error": "Could not extract enough text from document.",
                    "details": "Try a text-based document.",
                }, status=400)
                return
            
            prompt = (
                f"Document: {filename}\n\n"
                f"Content preview:\n{doc_text[:1500]}\n\n"
                "Please analyze this document and provide:\n"
                "1. Document summary\n"
                "2. Key points or sections\n"
                "3. Important information to extract\n"
                "4. If it's a resume: overall assessment and suggestions\n"
                "5. Any recommended improvements"
            )
            
            messages = [
                {"role": "system", "content": placement_system_prompt()},
                {"role": "user", "content": prompt},
            ]
            
            reply = self.call_hugging_face(token, {
                "model": MODEL,
                "messages": messages,
                "temperature": 0.65,
                "max_tokens": 1200,
            })
            
            self.send_json({
                "success": True,
                "document": {
                    "filename": filename,
                    "extracted_chars": len(doc_text),
                },
                "analysis": reply,
            })
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)

    def extract_document_text(self, filename, file_bytes):
        lowered = filename.lower()
        if lowered.endswith(".docx"):
            return self.extract_docx_text(file_bytes)
        elif lowered.endswith(".pdf"):
            return self.extract_pdf_text(file_bytes)
        elif lowered.endswith((".ppt", ".pptx")):
            return self.extract_pptx_text(file_bytes)
        elif lowered.endswith(".txt"):
            return file_bytes.decode("utf-8", errors="ignore")
        else:
            return file_bytes.decode("utf-8", errors="ignore")

    def extract_pptx_text(self, file_bytes):
        try:
            with zipfile.ZipFile(io.BytesIO(file_bytes)) as pptx:
                text_parts = []
                for name in pptx.namelist():
                    if name.startswith("ppt/slides/slide") and name.endswith(".xml"):
                        xml = pptx.read(name).decode("utf-8", errors="ignore")
                        text = re.sub(r"<[^>]+>", " ", xml)
                        text_parts.append(text)
                return " ".join(text_parts)
        except Exception:
            return "Could not extract PPTX text"

    def handle_export_chat(self):
        try:
            data = self.read_json_body()
            content = data.get("content", "")
            export_format = data.get("format", "txt").lower()
            
            if export_format == "docx":
                docx_bytes = self.html_to_docx(content)
                encoded = self.encode_base64(docx_bytes)
                self.send_json({
                    "success": True,
                    "data": encoded,
                    "filename": "chat-export.docx",
                })
            else:
                blob = content.encode("utf-8")
                encoded = self.encode_base64(blob)
                self.send_json({
                    "success": True,
                    "data": encoded,
                    "filename": f"chat-export.{export_format}",
                })
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)

    def send_json(self, data, status=200):
        encoded = json.dumps(data).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            return

def find_score_in_text(text, labels):
    for label in labels:
        escaped = re.escape(label)
        match = re.search(escaped + r"[^0-9]*(\d{1,3})", text, re.IGNORECASE)
        if match:
            return min(int(match.group(1)), 100)
    return None

class PlacementChatServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

def main():
    load_env_file()
    init_db()
    
    port = int(os.environ.get("PORT", 8000))
    host = "0.0.0.0"
    
    try:
        server = PlacementChatServer((host, port), PlacementChatHandler)
    except OSError as exc:
        if exc.errno in {10048, 98}:
            print(f"Port {port} is already in use. Stop the old server and try again.")
            return
        raise

    print(f"Placement Chatbot running at http://localhost:{port} (or http://127.0.0.1:{port})", flush=True)
    print(f"Using Hugging Face model: {MODEL}", flush=True)
    print(f"Hugging Face timeout: {HF_TIMEOUT_SECONDS}s", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nServer stopped.", flush=True)
    finally:
        server.server_close()

if __name__ == "__main__":
    main()
