export type StoryCategory = "date" | "friends" | "celebration" | "seated";
export interface StoryDeck { readonly id: string; readonly version: 1; readonly category: StoryCategory; readonly title: string; readonly description: string; readonly steps: readonly [string, string, string, string] }
const deck = (id: string, category: StoryCategory, title: string, description: string, steps: StoryDeck["steps"]): StoryDeck => Object.freeze({ id, version: 1, category, title, description, steps: Object.freeze(steps) });

export const STORY_DECKS: readonly StoryDeck[] = Object.freeze([
  deck("little-hello", "date", "A little hello", "Four small moments, however far apart you are.", [
    "Look into the camera as if your favourite person just arrived.",
    "Say hello with a small wave, a nod or a smile.",
    "Show the expression you make when they tell a good story.",
    "Finish with the smile you want them to remember.",
  ]),
  deck("our-little-ritual", "date", "Our little ritual", "Make an ordinary catch-up worth keeping.", [
    "Get comfortable and take a photo just as you are.",
    "Show a favourite everyday object, or imagine holding it.",
    "React to a lovely surprise from the other person.",
    "End with your own quiet goodbye.",
  ]),
  deck("movie-moment", "date", "Our tiny movie", "A whole little story in four expressions.", [
    "The opening scene: look curious about what happens next.",
    "Plot twist! Show a surprised face, as big or small as you like.",
    "The happy reveal: let your expression soften into a smile.",
    "The end credits: hold your favourite final expression.",
  ]),
  deck("same-energy", "friends", "Same energy", "Different places, one shared mood.", [
    "Everyone picks their version of a calm face.",
    "The director names a happy mood. Show your version.",
    "Now try an exaggerated serious face, or a small thoughtful look.",
    "Drop the act and finish with a natural smile.",
  ]),
  deck("album-cover", "friends", "The album cover", "Four portraits for your imaginary band.", [
    "Your debut cover: face the camera with quiet confidence.",
    "The acoustic edition: soften your expression and relax.",
    "The surprise single: choose a playful expression.",
    "The thank-you photo: smile at the people in your band.",
  ]),
  deck("passing-a-smile", "friends", "Pass a smile", "Let each person guide one small moment.", [
    "The director chooses a gentle expression for everyone to copy.",
    "The next director adds their own twist to that expression.",
    "Choose a tiny wave, a nod or a new smile together.",
    "Everyone keeps the expression that felt most like them.",
  ]),
  deck("birthday-wish", "celebration", "A birthday wish", "No candles or props needed.", [
    "Get ready for a tiny celebration. Look towards the camera.",
    "Make a wish silently, with your eyes open or closed.",
    "Imagine the wish coming true. Show that feeling.",
    "Send a smile to the person you're celebrating.",
  ]),
  deck("we-did-it", "celebration", "We did it", "For big milestones and small wins.", [
    "Remember the beginning. Give the camera a determined look.",
    "The hard part is over. Let your shoulders or expression relax.",
    "Show your version of a victory pose, as small as you like.",
    "Take a proud portrait of the people who made it happen.",
  ]),
  deck("a-new-chapter", "celebration", "A new chapter", "For fresh starts. No perfect pose needed.", [
    "Take a portrait of yourself as you start something new.",
    "Think of something you're looking forward to.",
    "Show a little courage, curiosity or excitement.",
    "Finish with an expression you'd send to your future self.",
  ]),
  deck("soft-expressions", "seated", "Soft expressions", "Stay seated or however you're comfortable. No need to move.", [
    "Get comfortable and look at the camera if you like.",
    "Think of a kind memory and let it show on your face.",
    "Try a thoughtful expression, or keep your natural one.",
    "Pick the expression you'd like to keep today.",
  ]),
  deck("quiet-company", "seated", "Quiet company", "A low-energy story with no props, touch or sound.", [
    "Just be here. Your resting expression is enough.",
    "Think of someone who makes you feel at ease.",
    "Choose a small smile, or stay exactly as you are.",
    "Take one last quiet portrait together.",
  ]),
  deck("four-moods", "seated", "Four little moods", "Just expressions. Skip any you like.", [
    "Curious: imagine hearing an interesting question.",
    "Thoughtful: imagine choosing your favourite answer.",
    "Delighted: imagine the answer made someone smile.",
    "Content: settle into your own comfortable expression.",
  ]),
]);

export const RELAXED_POSE = "Any comfortable expression works. You can stay still.";
export const STORY_CATEGORIES: Readonly<Record<StoryCategory, string>> = Object.freeze({ date: "Date", friends: "Friends", celebration: "Celebration", seated: "Seated & gentle" });
