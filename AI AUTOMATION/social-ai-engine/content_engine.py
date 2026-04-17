import os
from datetime import datetime
from dotenv import load_dotenv
from groq import Groq
import gspread
from google.oauth2.service_account import Credentials

load_dotenv()

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

def connect_to_sheet():
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]
    creds = Credentials.from_service_account_file("credentials.json", scopes=scopes)
    gc = gspread.authorize(creds)
    sheet = gc.open_by_key(os.getenv("SHEET_ID")).sheet1
    return sheet

def generate_linkedin_post(topic):
    response = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {
                "role": "system",
                "content": """You are a LinkedIn content writer. 
                Write professional, engaging LinkedIn posts that feel human and personal.
                Format rules:
                - Start with a strong hook (first line should grab attention)
                - 150 to 200 words total
                - Short paragraphs, maximum 2 sentences each
                - End with one thought-provoking question to encourage comments
                - Do NOT use hashtags
                - Do NOT use emojis
                - Sound like a real person sharing experience, not a robot"""
            },
            {
                "role": "user",
                "content": f"Write a LinkedIn post about this topic: {topic}"
            }
        ]
    )
    return response.choices[0].message.content

def save_to_sheet(sheet, topic, post):
    date = datetime.now().strftime("%Y-%m-%d %H:%M")
    sheet.append_row([date, topic, post])
    print("Saved to Google Sheets!")

def main():
    print("=== LinkedIn Post Generator ===")
    print("Connecting to Google Sheets...")

    try:
        sheet = connect_to_sheet()
        print("Connected! Ready to generate posts.")
    except Exception as e:
        print(f"Could not connect to Google Sheets: {e}")
        print("Posts will still generate but won't be saved.")
        sheet = None

    print("Type 'quit' anytime to exit")
    print()

    while True:
        topic = input("Enter your topic: ").strip()

        if topic.lower() == "quit":
            print("Goodbye!")
            break

        if not topic:
            print("Please enter a topic first.")
            continue

        print("\nGenerating your LinkedIn post...\n")

        try:
            post = generate_linkedin_post(topic)
            print("--- YOUR POST ---")
            print(post)
            print("----------------\n")

            if sheet:
                save_to_sheet(sheet, topic, post)

        except Exception as e:
            print(f"Something went wrong: {e}")
            print("Please try again.")

        print()
        another = input("Generate another post? (yes/no): ").strip().lower()
        if another != "yes":
            print("Goodbye!")
            break
        print()

if __name__ == "__main__":
    main()