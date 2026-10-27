const { GoogleGenAI } = require('@google/genai');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');

class LLMService {
  constructor() {
    this.client = null;
    this.model = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this.provider = 'gemini';
    this.nvidiaBaseUrl = null;
    this.nvidiaModel = null;
    this.nvidiaApiKey = null;

    this.initializeClient();
  }

  getLlmProvider() {
    const raw = String(process.env.LLM_PROVIDER || config.get('llm.provider') || 'nvidia').trim().toLowerCase();
    return raw === 'gemini' ? 'gemini' : 'nvidia';
  }

  getNvidiaSettings() {
    const baseUrl = String(
      process.env.NVIDIA_BASE_URL || config.get('llm.nvidia.baseUrl') || 'https://integrate.api.nvidia.com/v1'
    ).replace(/\/+$/, '');
    const model = String(
      process.env.NVIDIA_MODEL || config.get('llm.nvidia.model') || 'google/diffusiongemma-26b-a4b-it'
    ).trim();
    return { baseUrl, model, apiKey: config.getApiKey('NVIDIA') };
  }

  _useNvidia() {
    return this.provider === 'nvidia';
  }

  initializeClient() {
    this.provider = this.getLlmProvider();

    const nvidia = this.getNvidiaSettings();
    this.nvidiaBaseUrl = nvidia.baseUrl;
    this.nvidiaModel = nvidia.model;
    this.nvidiaApiKey = nvidia.apiKey;

    if (this._useNvidia()) {
      if (!this.nvidiaApiKey) {
        logger.warn('NVIDIA API key not configured', { keyExists: false });
        this.client = null;
        this.model = this.nvidiaModel;
        this.isInitialized = false;
        return;
      }
      this.client = null;
      this.model = this.nvidiaModel;
      this.isInitialized = true;
      logger.info('NVIDIA NIM client initialized successfully', {
        model: this.model,
        baseUrl: this.nvidiaBaseUrl
      });
      return;
    }

    const apiKey = config.getApiKey('GEMINI');
    
    if (!apiKey || apiKey === 'your-api-key-here') {
      logger.warn('Gemini API key not configured', { 
        keyExists: !!apiKey,
        isPlaceholder: apiKey === 'your-api-key-here'
      });
      return;
    }

    try {
      this.client = new GoogleGenAI({ apiKey });
      
      // Use the configured model name (default: gemini-3.5-flash-lite)
      this.model = config.get('llm.gemini.model');
      this.isInitialized = true;
      
      logger.info('Gemini AI client initialized successfully', {
        model: this.model
      });
    } catch (error) {
      logger.error('Failed to initialize Gemini client', { 
        error: error.message 
      });
    }
  }

  getGenerationConfig(overrides = {}) {
    const defaults = config.get('llm.gemini.generation') || {};
    const fallback = {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    };

    const merged = { ...fallback, ...defaults, ...overrides };
    return Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== null)
    );
  }

  applyGenerationDefaults(request, overrides = {}) {
    request.generationConfig = this.getGenerationConfig({ ...(request.generationConfig || {}), ...overrides });
    return request;
  }

  extractTextFromCandidates(response) {
    // New @google/genai SDK exposes response.text as a convenience getter.
    if (response && typeof response.text === 'string' && response.text.trim().length > 0) {
      return {
        text: response.text.trim(),
        candidate: response.candidates?.[0] || null,
        finishReason: response.candidates?.[0]?.finishReason || null
      };
    }

    const candidates = Array.isArray(response?.candidates)
      ? response.candidates
      : Array.isArray(response)
        ? response
        : [];

    if (!candidates.length) {
      throw new Error('No candidates in Gemini response');
    }

    const candidateWithText = candidates.find(candidate => {
      const parts = candidate?.content?.parts;
      return Array.isArray(parts) && parts.some(part => typeof part.text === 'string' && part.text.trim().length > 0);
    });

    if (!candidateWithText) {
      const finishReasons = candidates.map(c => c.finishReason || 'unknown').join(', ');
      throw new Error(`No text parts in candidates. Finish reasons: ${finishReasons}`);
    }

    const textParts = candidateWithText.content.parts
      .filter(part => typeof part.text === 'string' && part.text.trim().length > 0)
      .map(part => part.text.trim());

    if (!textParts.length) {
      throw new Error(`Candidate parts missing text after filtering: ${JSON.stringify(candidateWithText)}`);
    }

    const text = textParts.join('\n');

    return {
      text,
      candidate: candidateWithText,
      finishReason: candidateWithText.finishReason || null
    };
  }

  /**
   * Process an image directly with Gemini using the active skill prompt.
   * The image buffer is sent as inlineData alongside a concise instruction.
   * For image-based queries, we include the skill prompt (e.g., DSA) as systemInstruction.
   * @param {Buffer} imageBuffer - PNG/JPEG image bytes
   * @param {string} mimeType - e.g., 'image/png' or 'image/jpeg'
   * @param {string} activeSkill - current skill (e.g. 'general')
   * @param {Array} sessionMemory - optional (not required for image)
   * @param {string|null} programmingLanguage - optional language context for skills that need it
   * @returns {Promise<{response: string, metadata: object}>}
   */
  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check your AI provider API key in Settings.');
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkill');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      // Build system instruction using the skill prompt (with optional language injection)
      const { promptLoader } = require('../../prompt-loader');
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';

      // Build request with text + image parts
      const base64 = imageBuffer.toString('base64');

      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: this.formatImageInstruction(activeSkill, programmingLanguage) },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ]
      };

      this.applyGenerationDefaults(request);

      if (skillPrompt && skillPrompt.trim().length > 0) {
        request.systemInstruction = { parts: [{ text: skillPrompt }] };
      }

      // Execute with retries/timeout - try alternative method first for network reliability
      let responseText;
      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for reliability');
          responseText = await this.executeAlternativeRequest(request);
        } else {
          responseText = await this.executeRequest(request);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, { error: error.message });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);

        try {
          responseText = await secondaryFn(request);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed', {
            firstError: error.message,
            secondError: secondaryError.message
          });
          throw secondaryError;
        }
      }

      // Enforce language in code fences if provided
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(responseText, programmingLanguage)
        : responseText;

      logger.logPerformance('LLM image processing', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM image processing failed', {
        error: error.message,
        activeSkill,
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateFallbackResponse('[image]', activeSkill);
      }
      throw error;
    }
  }

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check your AI provider API key in Settings.');
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkillStream');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const { promptLoader } = require('../../prompt-loader');
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';
      const base64 = imageBuffer.toString('base64');

      const geminiRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: this.formatImageInstruction(activeSkill, programmingLanguage) },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ]
      };
      this.applyGenerationDefaults(geminiRequest);
      if (skillPrompt && skillPrompt.trim().length > 0) {
        geminiRequest.systemInstruction = { parts: [{ text: skillPrompt }] };
      }

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM image streaming', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      logger.warn('Streaming image analysis failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      return this.processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  formatImageInstruction(activeSkill, programmingLanguage) {
    const langNote = programmingLanguage ? ` If code is needed, write it in ${programmingLanguage.toUpperCase()}.` : '';
    return `Look at this image, extract the question being asked (any domain: math, physics, programming, languages, everyday topics — anything), then give a direct answer first followed by a brief explanation.${langNote} Respond ALWAYS in Polish. If it is a math problem, format all formulas with LaTeX ($...$ inline, $$...$$ display) and show the steps plus the final result.`;
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check your AI provider API key in Settings.');
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing text with LLM', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for text processing');
          response = await this.executeAlternativeRequest(geminiRequest);
        } else {
          response = await this.executeRequest(geminiRequest);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, {
          error: error.message,
          requestId: this.requestCount
        });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        try {
          response = await secondaryFn(geminiRequest);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed for text processing', {
            firstError: error.message,
            secondError: secondaryError.message,
            requestId: this.requestCount
          });
          throw secondaryError;
        }
      }
      
      // Enforce language in code fences if programmingLanguage specified
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM text processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateFallbackResponse(text, activeSkill);
      }

      throw error;
    }
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check your AI provider API key in Settings.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM text streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true
        }
      };
    } catch (error) {
      logger.warn('Streaming text failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      return this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check your AI provider API key in Settings.');
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing transcription with intelligent response', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for transcription processing');
          response = await this.executeAlternativeRequest(geminiRequest);
        } else {
          response = await this.executeRequest(geminiRequest);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, {
          error: error.message,
          requestId: this.requestCount
        });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        try {
          response = await secondaryFn(geminiRequest);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed for transcription processing', {
            firstError: error.message,
            secondError: secondaryError.message,
            requestId: this.requestCount
          });
          throw secondaryError;
        }
      }
      
      // Enforce language in code fences if programmingLanguage specified
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM transcription processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM transcription processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateIntelligentFallbackResponse(text, activeSkill);
      }
      
      throw error;
    }
  }

  /**
   * Normalize all triple-backtick code fences to the selected programming language tag.
   * Does not alter the inner code; only ensures fence language tags are correct.
   */
  enforceProgrammingLanguage(text, programmingLanguage) {
    try {
      if (!text || !programmingLanguage) return text;
      const norm = String(programmingLanguage).toLowerCase();
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const fenceTag = fenceTagMap[norm] || norm || 'text';

      // Replace all triple-backtick fences' language token with the selected tag
      const replacedBackticks = text.replace(/```([^\n]*)\n/g, (match, info) => {
        const current = (info || '').trim();
        // If already the desired fenceTag as the first token, keep as is
        if (current.split(/\s+/)[0].toLowerCase() === fenceTag) return match;
        return '```' + fenceTag + '\n';
      });

      // Optionally normalize tildes fences to backticks with correct tag
      const normalizedTildes = replacedBackticks.replace(/~~~([^\n]*)\n/g, () => '```' + fenceTag + '\n');

      return normalizedTildes;
    } catch (_) {
      return text;
    }
  }

  buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');
    
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to old method for compatibility - now with programming language support
    const requestComponents = promptLoader.getRequestComponents(
      activeSkill, 
      text, 
      sessionMemory,
      programmingLanguage
    );

    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Use the skill prompt that already has programming language injected
    if (requestComponents.shouldUseModelMemory && requestComponents.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: requestComponents.skillPrompt }]
      };
      
      logger.debug('Using language-enhanced system instruction for skill', {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        promptLength: requestComponents.skillPrompt.length,
        requiresProgrammingLanguage: requestComponents.requiresProgrammingLanguage
      });
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: this.formatUserMessage(text, activeSkill) }]
    });

    return request;
  }

  buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Use the skill prompt from context (which may already include programming language)
    if (skillContext.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: skillContext.skillPrompt }]
      };
      
      logger.debug('Using skill context prompt as system instruction', {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        promptLength: skillContext.skillPrompt.length,
        requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false,
        hasLanguageInjection: programmingLanguage && skillContext.requiresProgrammingLanguage
      });
    }

    // Add conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        return event.role !== 'system' && 
               event.content && 
               typeof event.content === 'string' && 
               event.content.trim().length > 0;
      })
      .map(event => {
        const content = event.content.trim();
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      });

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Format and validate the current user input
    const formattedMessage = this.formatUserMessage(text, activeSkill);
    if (!formattedMessage || formattedMessage.trim().length === 0) {
      throw new Error('Failed to format user message or message is empty');
    }

    // Add the current user input
    request.contents.push({
      role: 'user',
      parts: [{ text: formattedMessage }]
    });

    logger.debug('Built Gemini request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSystemInstruction: !!request.systemInstruction,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Validate input text first
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest');
    }

    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');
    
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(10);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildIntelligentTranscriptionRequestWithHistory(cleanText, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to basic intelligent request
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Add intelligent filtering system instruction
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
    if (!intelligentPrompt) {
      throw new Error('Failed to generate intelligent transcription prompt');
    }

    request.systemInstruction = {
      parts: [{ text: intelligentPrompt }]
    };

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    logger.debug('Built basic intelligent transcription request', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      textLength: cleanText.length,
      hasSystemInstruction: !!request.systemInstruction
    });

    return request;
  }

  buildIntelligentTranscriptionRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

  // For chat/transcription messages, DO NOT include the full skill prompt; use only the intelligent filter prompt
  const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
  request.systemInstruction = { parts: [{ text: intelligentPrompt }] };

    // Add recent conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        // Filter out system messages and ensure content exists and is valid
        return event.role !== 'system' && 
               event.content && 
               typeof event.content === 'string' && 
               event.content.trim().length > 0;
      })
      .slice(-8) // Keep last 8 exchanges for context
      .map(event => {
        const content = event.content.trim();
        if (!content) {
          logger.warn('Empty content found in conversation history', { event });
          return null;
        }
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      })
      .filter(content => content !== null); // Remove any null entries

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Validate and add the current transcription
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided');
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    // Ensure we have at least one content item
    if (request.contents.length === 0) {
      throw new Error('No valid content to send to Gemini API');
    }

    logger.debug('Built intelligent transcription request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSkillPrompt: !!skillContext.skillPrompt,
      cleanTextLength: cleanText.length,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    let prompt = `# Universal Assistant — answer any question directly

You are a general-purpose assistant. The user can ask about ANYTHING: math, physics,
programming, history, languages, work, study, everyday life. Always answer the question
that was actually asked — never refuse, never redirect to another topic.

## How to answer
1. Direct answer first (1–3 lines, exactly what was asked).
2. Then a brief explanation: key steps, reasoning, or a short example.
3. Keep it simple and complete. No filler, no repeating the question.
4. ALWAYS respond in Polish, no matter what language the user's question
   is in. Code (if any) keeps its programming language, but every
   explanation around it is in Polish.

## Code questions
- Only when the question asks for code (or clearly requires it), include clean code
  with triple backticks and the correct language tag.`;

    // Add programming language context if provided
    if (programmingLanguage) {
      const lang = String(programmingLanguage).toLowerCase();
      const languageMap = { cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript', js: 'JavaScript' };
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const languageTitle = languageMap[lang] || (lang.charAt(0).toUpperCase() + lang.slice(1));
      const fenceTag = fenceTagMap[lang] || lang || 'text';
      prompt += `\n- When code is needed and no other language was requested, write it in ${languageTitle} (fences tagged \`\`\`${fenceTag}\`\`\`).`;
    }

    prompt += `

## Math questions — beautiful formatting (REQUIRED)
- Format EVERY formula with LaTeX so it renders nicely:
  - inline math: \`$...$\` (e.g. \`$x^2 + 2x + 1 = 0$\`)
  - display formulas on their own lines: \`$$...$$\`
- Use \\frac{a}{b}, x^{2}, x_{n}, \\sqrt{x}, \\sum, \\int, \\cdot, \\leq, \\geq,
  \\neq, \\infty, \\pi and other standard LaTeX commands.
- Solve step by step: given → steps → final result highlighted
  (e.g. **Answer:** \`$$x = 2$$\`).

## What NOT to do
- Do NOT say "ask a question relevant to X" — every question is relevant.
- Do NOT force code into non-coding answers.
- Do NOT give one-word answers without explanation, and do NOT over-explain either.

Just answer the question simply, with a short explanation.`;

    return prompt;
  }

  formatUserMessage(text, activeSkill) {
    return `Question:\n${text}`;
  }

  async executeRequest(geminiRequest) {
    if (this._useNvidia()) {
      return this.executeNvidiaRequest(geminiRequest, null);
    }
    const maxRetries = config.get('llm.gemini.maxRetries');
    const timeout = config.get('llm.gemini.timeout');
    const primaryModel = this.model;
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    logger.debug('Executing Gemini request', {
      hasModel: !!this.model,
      hasClient: !!this.client,
      requestKeys: Object.keys(geminiRequest),
      timeout,
      maxRetries,
      modelsToTry,
      nodeVersion: process.version,
      platform: process.platform
    });

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout')), timeout)
          );

          logger.debug(`Gemini API attempt ${attempt} starting with model ${modelName}`, {
            timestamp: new Date().toISOString(),
            timeout,
            model: modelName
          });

          const requestPromise = this.client.models.generateContent({
            model: modelName,
            contents: geminiRequest.contents,
            config: geminiRequest.generationConfig,
            systemInstruction: geminiRequest.systemInstruction
          });
          const result = await Promise.race([requestPromise, timeoutPromise]);

          if (!result) {
            throw new Error('Empty response from Gemini API');
          }

          const { text, finishReason } = this.extractTextFromCandidates(result);

          if (finishReason === 'MAX_TOKENS') {
            logger.warn('Gemini response reached max tokens limit', {
              attempt,
              finishReason,
              model: modelName
            });
          }

          logger.debug('Gemini API request successful', {
            attempt,
            model: modelName,
            responseLength: text.length,
            finishReason
          });

          return text;
        } catch (error) {
          const errorInfo = this.analyzeError(error);
          lastError = error;

          // Enhanced error logging for fetch failures
          if (errorInfo.type === 'NETWORK_ERROR') {
            logger.error('Network error details', {
              attempt,
              model: modelName,
              errorMessage: error.message,
              errorStack: error.stack,
              errorName: error.name,
              nodeEnv: process.env.NODE_ENV,
              electronVersion: process.versions.electron,
              chromeVersion: process.versions.chrome,
              nodeVersion: process.versions.node,
              userAgent: this.getUserAgent()
            });
          }

          logger.warn(`Gemini API attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            isNetworkError: errorInfo.isNetworkError,
            suggestedAction: errorInfo.suggestedAction,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          // For model-unavailable / overloaded / rate-limit errors, move to
          // the next fallback model immediately instead of burning all retries.
          const isModelUnavailable = errorInfo.type === 'RATE_LIMIT_ERROR' ||
            error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand');

          if (isModelUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            logger.info(`Switching to fallback model after ${modelName} unavailable`, {
              model: modelName,
              error: error.message
            });
            break; // exit retry loop for this model and try next model
          }

          if (attempt === maxRetries) {
            break; // exit retry loop for this model and try next model
          }

          // Use exponential backoff with jitter for network errors
          const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
          const delay = baseDelay * attempt + Math.random() * 1000;

          logger.debug(`Waiting ${delay}ms before retry ${attempt + 1}`, {
            baseDelay,
            isNetworkError: errorInfo.isNetworkError,
            model: modelName
          });

          await this.delay(delay);
        }
      }
    }

    const finalErrorInfo = this.analyzeError(lastError);
    const finalError = new Error(`Gemini API failed after trying ${modelsToTry.join(', ')}: ${lastError?.message}`);
    finalError.errorAnalysis = finalErrorInfo;
    finalError.originalError = lastError;
    throw finalError;
  }

  /**
   * Streaming sibling of processTranscriptionWithIntelligentResponse. Emits
   * incremental text via onDelta so the UI can render the answer as it is
   * generated (much faster perceived latency). Returns the same
   * {response, metadata} shape. Falls back to the non-streaming path on any
   * streaming failure so reliability is never worse than before.
   */
  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check your AI provider API key in Settings.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const geminiRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM transcription streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      logger.warn('Streaming transcription failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      // Non-streaming path returns the same shape; the caller renders it as a
      // single final response.
      return this.processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  /** Safely pull the text delta out of a streamed Gemini chunk. */
  _extractChunkText(chunk) {
    try {
      const t = chunk && chunk.text;
      if (typeof t === 'string') {
        return t;
      }
    } catch (_) {
      // `.text` getter can throw on non-text parts; fall through to manual read.
    }
    try {
      const parts = (chunk && chunk.candidates && chunk.candidates[0] &&
        chunk.candidates[0].content && chunk.candidates[0].content.parts) || [];
      return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    } catch (_) {
      return '';
    }
  }

  /**
   * Run a streaming Gemini request with the same model-fallback + retry policy
   * as executeRequest. Accumulates and returns the full text; invokes onDelta
   * for each chunk.
   */
  async executeStreamingRequest(geminiRequest, onDelta) {
    if (this._useNvidia()) {
      return this.executeNvidiaRequest(geminiRequest, onDelta);
    }
    const maxRetries = config.get('llm.gemini.maxRetries');
    const apiKey = config.getApiKey('GEMINI');
    const primaryModel = this.model;
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const fullText = await this._streamRequestForModel(geminiRequest, modelName, apiKey, onDelta);

          if (!fullText) {
            throw new Error('Empty streamed response from Gemini API');
          }

          logger.debug('Gemini streaming request successful', {
            attempt,
            model: modelName,
            responseLength: fullText.length
          });

          return fullText;
        } catch (error) {
          const errorInfo = this.analyzeError(error);
          lastError = error;

          logger.warn(`Gemini streaming attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          const isModelUnavailable = errorInfo.type === 'RATE_LIMIT_ERROR' ||
            error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand');

          if (isModelUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            break; // try next fallback model
          }

          if (attempt === maxRetries) {
            break;
          }

          const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
          const delay = baseDelay * attempt + Math.random() * 1000;
          await this.delay(delay);
        }
      }
    }

    throw lastError || new Error('Gemini streaming request failed');
  }

  _streamRequestForModel(geminiRequest, modelName, apiKey, onDelta) {
    const https = require('https');
    const timeout = config.get('llm.gemini.timeout');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;
    const postData = JSON.stringify(geminiRequest);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout,
      agent
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        let fullText = '';
        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) {
              continue;
            }
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
              continue;
            }
            try {
              const json = JSON.parse(payload);
              const piece = this._extractChunkText(json);
              if (piece) {
                fullText += piece;
                if (typeof onDelta === 'function') {
                  onDelta(piece);
                }
              }
            } catch (_) {
              // Partial JSON across chunk boundaries is rare with line framing;
              // skip anything that doesn't parse cleanly.
            }
          }
        });

        res.on('end', () => resolve(fullText.trim()));
        res.on('error', (error) => reject(new Error(`Streaming response error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`Streaming request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Streaming request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Convert an internal Gemini-style request ({systemInstruction, contents})
   * into OpenAI-compatible chat messages for NVIDIA NIM.
   */
  _toOpenAIMessages(geminiRequest) {
    const messages = [];
    const sysParts = (geminiRequest.systemInstruction && geminiRequest.systemInstruction.parts) || [];
    const sysText = sysParts
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
    if (sysText) {
      messages.push({ role: 'system', content: sysText });
    }
    for (const content of geminiRequest.contents || []) {
      const role = content.role === 'model' ? 'assistant' : 'user';
      const texts = [];
      const images = [];
      for (const part of content.parts || []) {
        if (part && typeof part.text === 'string' && part.text) {
          texts.push(part.text);
        } else if (part && part.inlineData && part.inlineData.data) {
          images.push({
            type: 'image_url',
            image_url: {
              url: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`
            }
          });
        }
      }
      if (images.length > 0) {
        messages.push({
          role,
          content: [{ type: 'text', text: texts.join('\n') || 'What is in this image?' }, ...images]
        });
      } else if (texts.length > 0) {
        messages.push({ role, content: texts.join('\n') });
      }
    }
    return messages;
  }

  /**
   * Execute a request against NVIDIA NIM (OpenAI-compatible chat API).
   * When onDelta is a function the request streams (SSE) and deltas are
   * forwarded; otherwise a single JSON response is returned. Returns the
   * full response text in both cases.
   */
  async executeNvidiaRequest(geminiRequest, onDelta = null) {
    if (!this.nvidiaApiKey) {
      throw new Error('NVIDIA API key not configured. Set it in Settings → AI Provider.');
    }
    const messages = this._toOpenAIMessages(geminiRequest);
    if (!messages.length) {
      throw new Error('No valid content to send to NVIDIA NIM');
    }
    // Diffusion/thinking models: demand minimal thinking and an immediate
    // answer — otherwise they spend time on long internal reasoning.
    if (this._nvidiaNeedsThinkingTemplate()) {
      const speedNote = 'IMPORTANT: think as briefly as possible — do NOT reason step by step and do NOT show your thinking. Reply in AT MOST 3-4 short sentences with the key info only. Use the SIMPLEST everyday words, like a school student answering a question in their own words — no filler, no water, no fancy vocabulary, no introductions, no summaries, no bullet lists unless asked. Output ONLY the direct final answer immediately. Speed matters more than showing your work.';
      const sys = messages.find((msg) => msg && msg.role === 'system');
      if (sys && typeof sys.content === 'string') {
        sys.content += `\n\n${speedNote}`;
      } else {
        messages.unshift({ role: 'system', content: speedNote });
      }
    }
    const gen = (geminiRequest && geminiRequest.generationConfig) || {};
    const nvidiaCfg = config.get('llm.nvidia') || {};
    const body = {
      model: this.nvidiaModel,
      messages,
      // Thinking/diffusion models (e.g. DiffusionGemma) need the thinking
      // chat template enabled — without it they return an empty content.
      // Only sent for such models so plain chat models never see an
      // unknown field.
      ...(this._nvidiaNeedsThinkingTemplate() ? { chat_template_kwargs: { enable_thinking: true } } : {}),
      temperature: typeof nvidiaCfg.temperature === 'number' ? nvidiaCfg.temperature : 1,
      top_p: typeof nvidiaCfg.topP === 'number' ? nvidiaCfg.topP : 0.95,
      // Thinking models share one token budget between hidden thinking
      // and the visible answer — keep it generous so answers are never
      // cut mid-sentence; short answers come from the prompt, not the cap.
      max_tokens: this._nvidiaNeedsThinkingTemplate()
        ? Math.min(
            typeof gen.maxOutputTokens === 'number' ? gen.maxOutputTokens : 4096,
            typeof nvidiaCfg.thinkingMaxTokens === 'number' ? nvidiaCfg.thinkingMaxTokens : 4096
          )
        : (typeof gen.maxOutputTokens === 'number' ? gen.maxOutputTokens : 4096),
      stream: typeof onDelta === 'function'
    };

    const maxRetries = config.get('llm.nvidia.maxRetries') || 2;
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (body.stream) {
          const fullText = await this._nvidiaStreamChat(body, onDelta);
          if (!fullText) {
            throw new Error('Empty streamed response from NVIDIA NIM');
          }
          return fullText;
        }
        return await this._nvidiaJsonChat(body);
      } catch (error) {
        lastError = error;
        logger.warn(`NVIDIA NIM attempt ${attempt} failed`, {
          error: error.message,
          remainingAttempts: maxRetries - attempt,
          model: this.nvidiaModel
        });
        if (attempt === maxRetries) {
          break;
        }
        await this.delay(1500 * attempt + Math.random() * 1000);
      }
    }
    throw lastError || new Error('NVIDIA NIM request failed');
  }

  /**
   * Thinking/diffusion models need `chat_template_kwargs.enable_thinking`,
   * otherwise they answer with an empty `content` (reasoning only).
   */
  _nvidiaNeedsThinkingTemplate() {
    return /diffusion|think|r1|reason/i.test(this.nvidiaModel || '');
  }

  _nvidiaRequestOptions(body) {
    const timeout = config.get('llm.nvidia.timeout') || 45000;
    const postData = JSON.stringify(body);
    const https = require('https');
    const url = `${this.nvidiaBaseUrl}/chat/completions`;
    return {
      url,
      postData,
      timeout,
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.nvidiaApiKey}`,
          Accept: body.stream ? 'text/event-stream' : 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': this.getUserAgent()
        },
        timeout,
        agent: new https.Agent({ keepAlive: true, maxSockets: 1 })
      }
    };
  }

  _nvidiaJsonChat(body) {
    const https = require('https');
    const { url, postData, options } = this._nvidiaRequestOptions(body);
    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`NVIDIA NIM HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
            return;
          }
          try {
            const json = JSON.parse(raw);
            // Thinking/diffusion models may leave `content` empty and put
            // the answer into `reasoning_content` — accept either.
            const message = (json && json.choices && json.choices[0] && json.choices[0].message) || {};
            const finishReason = (json && json.choices && json.choices[0] && json.choices[0].finish_reason) || null;
            const content = typeof message.content === 'string' ? message.content : '';
            const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
            const text = content.trim() || reasoning.trim();
            if (!text) {
              const keys = message && typeof message === 'object' ? Object.keys(message).join(',') : 'none';
              reject(new Error(`Empty response from NVIDIA NIM (message fields: ${keys || 'none'})`));
              return;
            }
            if (finishReason === 'length') {
              logger.warn('NVIDIA NIM answer may be cut by the token limit', { finishReason });
            }
            resolve(text);
          } catch (e) {
            reject(new Error(`Invalid NVIDIA NIM response: ${e.message}`));
          }
        });
        res.on('error', (error) => reject(new Error(`NVIDIA NIM response error: ${error.message}`)));
      });
      req.on('error', (error) => reject(new Error(`NVIDIA NIM request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('NVIDIA NIM request timeout'));
      });
      req.write(postData);
      req.end();
    });
  }

  _nvidiaStreamChat(body, onDelta) {
    const https = require('https');
    const { url, postData, options } = this._nvidiaRequestOptions(body);
    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`NVIDIA NIM HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`)));
          return;
        }
        let fullText = '';
        let reasonText = '';
        let buffer = '';
        let sawDone = false;
        let finishReason = null;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) {
              continue;
            }
            const payload = line.slice(5).trim();
            if (!payload) {
              continue;
            }
            if (payload === '[DONE]') {
              sawDone = true;
              continue;
            }
            try {
              const json = JSON.parse(payload);
              const choice = (json && json.choices && json.choices[0]) || {};
              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }
              const delta = choice.delta || {};
              const think = delta.reasoning_content || '';
              if (think) {
                reasonText += think;
              }
              const piece = delta.content || '';
              if (piece) {
                fullText += piece;
                if (typeof onDelta === 'function') {
                  onDelta(piece);
                }
              }
            } catch (_) {
              // Partial JSON across chunk boundaries; skip unparsable lines.
            }
          }
        });
        res.on('end', () => {
          // Thinking-only answer: flush the reasoning as the response so the
          // UI never shows an empty bubble.
          let finalText = fullText.trim();
          if (!finalText && reasonText.trim() && typeof onDelta === 'function') {
            onDelta(reasonText.trim());
            finalText = reasonText.trim();
          }
          if (finishReason === 'length') {
            logger.warn('NVIDIA NIM streamed answer may be cut by the token limit', { finishReason });
          }
          // A stream that ends without the [DONE] terminator was cut off
          // mid-flight (dropped connection) — fail loudly so the caller
          // retries / falls back instead of showing a half answer as final.
          if (!sawDone) {
            reject(new Error('NVIDIA NIM stream ended without completion marker; response may be incomplete'));
            return;
          }
          resolve(finalText);
        });
        res.on('error', (error) => reject(new Error(`NVIDIA NIM streaming error: ${error.message}`)));
      });
      req.on('error', (error) => reject(new Error(`NVIDIA NIM request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('NVIDIA NIM request timeout'));
      });
      req.write(postData);
      req.end();
    });
  }

  async performPreflightCheck() {
    // Quick connectivity check
    try {
      const startTime = Date.now();
      await this.testNetworkConnection({ 
        host: 'generativelanguage.googleapis.com', 
        port: 443, 
        name: 'Gemini API Endpoint' 
      });
      const latency = Date.now() - startTime;
      
      logger.debug('Preflight check passed', { latency });
    } catch (error) {
      logger.warn('Preflight check failed', { 
        error: error.message,
        suggestion: 'Network connectivity issue detected before API call'
      });
      // Don't throw here - let the actual API call fail with more detail
    }
  }

  getUserAgent() {
    try {
      // Try to get user agent from Electron if available
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        return navigator.userAgent;
      }
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return 'Unknown';
    }
  }

  analyzeError(error) {
    const errorMessage = error.message.toLowerCase();
    
    // Network connectivity errors
    if (errorMessage.includes('fetch failed') || 
        errorMessage.includes('network error') ||
        errorMessage.includes('enotfound') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('timeout')) {
      return {
        type: 'NETWORK_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check internet connection and firewall settings'
      };
    }
    
    // API key errors
    if (errorMessage.includes('unauthorized') || 
        errorMessage.includes('invalid api key') ||
        errorMessage.includes('forbidden')) {
      return {
        type: 'AUTH_ERROR',
        isNetworkError: false,
        suggestedAction: 'Verify Gemini API key configuration'
      };
    }
    
    // Rate limiting
    if (errorMessage.includes('quota') || 
        errorMessage.includes('rate limit') ||
        errorMessage.includes('too many requests')) {
      return {
        type: 'RATE_LIMIT_ERROR',
        isNetworkError: false,
        suggestedAction: 'Wait before retrying or check API quota'
      };
    }
    
    // Timeout errors
    if (errorMessage.includes('request timeout') || errorMessage.includes('etimedout')) {
      return {
        type: 'TIMEOUT_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check network latency or increase timeout'
      };
    }
    
    return {
      type: 'UNKNOWN_ERROR',
      isNetworkError: false,
      suggestedAction: 'Check logs for more details'
    };
  }

  async checkNetworkConnectivity() {
    const connectivityTests = [
      { host: 'google.com', port: 443, name: 'Google (HTTPS)' },
      { host: 'generativelanguage.googleapis.com', port: 443, name: 'Gemini API Endpoint' }
    ];

    const results = await Promise.allSettled(
      connectivityTests.map(test => this.testNetworkConnection(test))
    );

    const connectivity = {
      timestamp: new Date().toISOString(),
      tests: results.map((result, index) => ({
        ...connectivityTests[index],
        success: result.status === 'fulfilled' && result.value,
        error: result.status === 'rejected' ? result.reason.message : null
      }))
    };

    logger.info('Network connectivity check completed', connectivity);
    return connectivity;
  }

  async testNetworkConnection({ host, port, name }) {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Connection failed to ${host}:${port}: ${error.message}`));
      });

      socket.connect(port, host);
    });
  }

  generateFallbackResponse(text, activeSkill) {
    logger.info('Generating fallback response', { activeSkill });

    const response = 'Nie mogę teraz połączyć się z usługą AI. Sprawdź klucz API i połączenie z internetem, a następnie zadaj pytanie ponownie — odpowiadam na pytania z każdej dziedziny z krótkim wyjaśnieniem.';

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true
      }
    };
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    logger.info('Generating intelligent fallback response for transcription', { activeSkill });

    const cleanText = (text || '').trim();
    // Universal assistant: never refuse — acknowledge and invite a rephrase.
    const response = cleanText
      ? `Usłyszałem: "${cleanText.length > 160 ? cleanText.substring(0, 160) + '…' : cleanText}". Usługa AI jest teraz nieosiągalna — sprawdź połączenie i klucz API, a następnie zapytaj ponownie, a odpowiem z krótkim wyjaśnieniem.`
      : 'Słucham. Zadaj pytanie, a odpowiem z krótkim wyjaśnieniem.';
    
    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isTranscriptionResponse: true
      }
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }

    if (this._useNvidia()) {
      return this.testNvidiaConnection();
    }

    try {
      // First check network connectivity
      const networkCheck = await this.checkNetworkConnectivity();
      const hasNetworkIssues = networkCheck.tests.some(test => !test.success);
      
      if (hasNetworkIssues) {
        logger.warn('Network connectivity issues detected', networkCheck);
      }

      const generationConfig = this.getGenerationConfig({ temperature: 0, maxOutputTokens: 64 });
      const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
      const modelsToTry = [this.model, ...fallbackModels];

      let lastError = null;
      let result = null;
      let usedModel = null;

      for (const modelName of modelsToTry) {
        try {
          const startTime = Date.now();
          result = await this.client.models.generateContent({
            model: modelName,
            contents: 'Test connection. Please respond with "OK".',
            config: generationConfig
          });
          usedModel = modelName;
          const latency = Date.now() - startTime;
          const { text } = this.extractTextFromCandidates(result);

          logger.info('Connection test successful', {
            response: text,
            latency,
            model: usedModel,
            networkCheck: hasNetworkIssues ? 'issues_detected' : 'healthy'
          });

          return {
            success: true,
            response: text,
            latency,
            model: usedModel,
            networkConnectivity: networkCheck
          };
        } catch (error) {
          lastError = error;
          logger.warn(`Connection test failed for model ${modelName}`, {
            error: error.message,
            model: modelName
          });

          const isModelUnavailable = error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand') ||
            error.message.includes('quota') ||
            error.message.includes('rate limit');

          if (!isModelUnavailable && modelName === this.model) {
            // Primary model failed for a non-availability reason; don't hide it
            break;
          }
        }
      }

      throw lastError || new Error('Connection test failed on all models');
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Connection test failed', {
        error: error.message,
        errorAnalysis
      });

      // Map raw SDK errors to user-friendly messages. The wizard only
      // surfaces `error`, so any raw SDK error string would land in the
      // UI verbatim.
      const friendlyError = this._friendlyTestError(error, errorAnalysis);

      return {
        success: false,
        error: friendlyError,
        errorType: errorAnalysis?.type || 'UNKNOWN',
        errorAnalysis,
        networkConnectivity: await this.checkNetworkConnectivity().catch(() => null)
      };
    }
  }

  async testNvidiaConnection() {
    const startTime = Date.now();
    try {
      const text = await this._nvidiaJsonChat({
        model: this.nvidiaModel,
        messages: [{ role: 'user', content: 'Test connection. Please respond with "OK".' }],
        ...(this._nvidiaNeedsThinkingTemplate() ? { chat_template_kwargs: { enable_thinking: true } } : {}),
        temperature: 1,
        max_tokens: 64,
        stream: false
      });
      const latency = Date.now() - startTime;
      logger.info('NVIDIA NIM connection test successful', {
        response: text,
        latency,
        model: this.nvidiaModel
      });
      return {
        success: true,
        response: text,
        latency,
        model: this.nvidiaModel,
        provider: 'nvidia'
      };
    } catch (error) {
      const msg = (error.message || '').toLowerCase();
      let friendly;
      if (msg.includes('401') || msg.includes('403') || msg.includes('api key') || msg.includes('unauthorized')) {
        friendly = 'Nieprawidłowy klucz API NVIDIA. Sprawdź klucz na build.nvidia.com.';
      } else if (msg.includes('404') || msg.includes('model')) {
        friendly = 'Model NVIDIA jest niedostępny. Sprawdź nazwę modelu w Settings.';
      } else if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit')) {
        friendly = 'Przekroczono limit / quota NVIDIA. Poczekaj chwilę i spróbuj ponownie.';
      } else if (msg.includes('timeout') || msg.includes('enotfound') || msg.includes('econn')) {
        friendly = 'Nie można połączyć się z serwerami NVIDIA. Sprawdź internet, firewall lub VPN.';
      } else {
        friendly = error.message || 'Connection failed';
      }
      logger.error('NVIDIA NIM connection test failed', { error: error.message });
      return { success: false, error: friendly, provider: 'nvidia' };
    }
  }

  /**
   * Translate raw SDK / network errors into something a user can act on.
   */
  _friendlyTestError(error, analysis) {
    const type = analysis?.type;
    const raw = (error?.message || '').toLowerCase();

    if (type === 'NETWORK_ERROR' || raw.includes('fetch failed') || raw.includes('enotfound')) {
      return 'Nie można połączyć się z serwerami Google. Sprawdź internet, firewall lub VPN.';
    }
    if (type === 'AUTH_ERROR' || raw.includes('api key') || raw.includes('401') || raw.includes('403')) {
      return 'Nieprawidłowy klucz API lub brak uprawnień. Sprawdź klucz na aistudio.google.com/apikey.';
    }
    if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
      return 'Przekroczono limit lub quota. Poczekaj chwilę lub sprawdź billing Google Cloud.';
    }
    if (type === 'TIMEOUT_ERROR') {
      return 'Przekroczono czas żądania. API Google może być wolne lub nieosiągalne.';
    }
    if (type === 'MODEL_ERROR' || raw.includes('model') || raw.includes('404')) {
      return 'Skonfigurowany model Gemini jest niedostępny. Wybierz inny model w Settings.';
    }
    if (raw.includes('503') || raw.includes('unavailable') || raw.includes('high demand')) {
      return 'Gemini jest przeciążone. Poczekaj chwilę i spróbuj ponownie.';
    }
    // Fall back to a stripped-down raw message (no SDK prefix noise)
    return (error?.message || 'Connection failed').replace(/^\[(GoogleGenerativeAI|GoogleGenAI) Error\]:\s*/i, '');
  }

  updateApiKey(newApiKey) {
    process.env.GEMINI_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();
    
    logger.info('API key updated and client reinitialized');
  }

  getStats() {
    return {
      provider: this.provider,
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      model: this.model,
      nvidia: {
        baseUrl: this.nvidiaBaseUrl,
        model: this.nvidiaModel,
        hasApiKey: !!this.nvidiaApiKey
      },
      config: config.get('llm.gemini')
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async executeAlternativeRequest(geminiRequest) {
    if (this._useNvidia()) {
      return this.executeNvidiaRequest(geminiRequest, null);
    }
    const https = require('https');
    const apiKey = config.getApiKey('GEMINI');
    const primaryModel = config.get('llm.gemini.model');
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    logger.info('Using alternative HTTPS request method', { modelsToTry });

    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        const result = await this._executeAlternativeRequestForModel(geminiRequest, modelName, apiKey);
        return result;
      } catch (error) {
        lastError = error;
        logger.warn(`Alternative HTTPS request failed for model ${modelName}`, {
          error: error.message,
          model: modelName
        });

        const isModelUnavailable = error.message.includes('503') ||
          error.message.includes('UNAVAILABLE') ||
          error.message.includes('high demand');

        if (!isModelUnavailable && modelName === primaryModel) {
          break;
        }
      }
    }

    throw lastError || new Error('Alternative HTTPS request failed for all models');
  }

  async _executeAlternativeRequestForModel(geminiRequest, modelName, apiKey) {
    const https = require('https');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const postData = JSON.stringify(geminiRequest);

    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout: config.get('llm.gemini.timeout'),
      agent
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            
            const response = JSON.parse(data);
            
            logger.debug('Alternative request response structure', {
              hasResponse: !!response,
              hasCandidates: !!response.candidates,
              candidatesLength: response.candidates?.length,
              responseKeys: Object.keys(response || {}),
              firstCandidateKeys: response.candidates?.[0] ? Object.keys(response.candidates[0]) : []
            });

            const { text, finishReason } = this.extractTextFromCandidates(response);

            if (finishReason === 'MAX_TOKENS') {
              logger.warn('Gemini alternative response reached max tokens limit', {
                finishReason
              });
            }
            
            logger.info('Alternative request successful', {
              responseLength: text.length,
              statusCode: res.statusCode,
              finishReason
            });
            
            resolve(text.trim());
          } catch (parseError) {
            logger.error('Failed to parse alternative response', {
              error: parseError.message,
              rawResponse: data.substring(0, 500),
              statusCode: res.statusCode
            });
            reject(new Error(`Failed to parse response: ${parseError.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(new Error(`Alternative request failed: ${error.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Alternative request timeout'));
      });
      
      req.write(postData);
      req.end();
    });
  }
}

module.exports = new LLMService();