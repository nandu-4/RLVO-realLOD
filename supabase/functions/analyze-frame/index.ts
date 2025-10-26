import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { imageData } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    console.log('Analyzing frame for head count and eye blinks...');

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this proctoring image for exam integrity. Provide:
1) headCount: Exact number of human heads/faces (0, 1, 2+)
2) eyesBlinked: Whether eyes are completely closed/blinking
3) headOrientation: "facing_camera", "turned_left", "turned_right", "looking_down", "looking_up"
4) gazeDeviation: Boolean - are eyes looking significantly away from camera (pupils shifted to corners, not centered in eyes)?
5) handsDetected: Boolean - are hands/arms visible in upper portion of frame (above chest level, suggesting phone use, note reading, or gesturing)?
6) suspiciousActivity: String - brief description if any concerning behavior detected (e.g., "hand near face", "looking at secondary screen", "multiple people") or "none"
7) confidence: Float 0-1 indicating detection confidence

Respond ONLY in JSON: {"headCount": <number>, "eyesBlinked": <boolean>, "headOrientation": <string>, "gazeDeviation": <boolean>, "handsDetected": <boolean>, "suspiciousActivity": <string>, "confidence": <float>}`
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageData
                }
              }
            ]
          }
        ],
        response_format: { type: "json_object" }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI API error:', response.status, errorText);
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    const analysis = JSON.parse(content);
    
    console.log('Analysis result:', analysis);

    return new Response(JSON.stringify(analysis), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error analyzing frame:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
