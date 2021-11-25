import { createQueryBuilder, In, Like, SelectQueryBuilder } from "typeorm";
import { PostAnswer } from "../entities/PostAnswer";
import { PostQuestion } from "../entities/PostQuestion";
import { PostQuestionHasTag } from "../entities/PostQuestionHasTag";
import { Tag } from "../entities/Tag";
import { UserHasTag } from "../entities/UserHasTag";
import NoSuchQuestionError from "../errors/NoSuchQuestionError";
import AnswerInput from "../dto/AnswerInput";
import QuestionInput from "../dto/QuestionInput";
import SearchQuestionInput from "../dto/SearchQuestionInput";
import { Service } from "typedi";
import UserHasTagRepository from "../repositories/UserHasTagRepository";
import { InjectRepository } from "typeorm-typedi-extensions";
import PostQuestionHasTagRepository from "../repositories/PostQuestionHasTagRepostiory";
import AnswerRepository from "../repositories/AnswerRepository";
import UserRepository from "../repositories/UserRepository";
import QuestionRepository from "../repositories/QuestionRepository";
import AnswerThumbRepository from "../repositories/AnswerThumbRepository";
import QuestionThumbRepository from "../repositories/QuestionThumbRepository";
import AuthorizationError from "../errors/AuthorizationError";
import CommonError from "../errors/CommonError";

@Service()
export default class PostService {
  constructor(
    @InjectRepository()
    private readonly userRepository: UserRepository,
    @InjectRepository()
    private readonly userHasTagRepository: UserHasTagRepository,
    @InjectRepository()
    private readonly questionRepository: QuestionRepository,
    @InjectRepository()
    private readonly postQuestionHasTagRepository: PostQuestionHasTagRepository,
    @InjectRepository()
    private readonly answerRepository: AnswerRepository,
    @InjectRepository()
    private readonly questionThumbRepository: QuestionThumbRepository,
    @InjectRepository()
    private readonly answerThumbRepository: AnswerThumbRepository
  ) {}

  private static DEFALUT_TAKE_QUESTIONS_COUNT = 20;
  public async findAllQuestionByArgs(
    args: SearchQuestionInput
  ): Promise<PostQuestion[]> {
    const { author, tagIDs, skip, take } = args;
    const { title, desc, realtimeShare } = args;

    const whereObj: Record<string, unknown> = {};

    if (realtimeShare) whereObj.realtimeShare = realtimeShare;
    if (title) whereObj.title = Like(`%${title}%`);
    if (desc) whereObj.desc = Like(`%${desc}%`);

    if (author) {
      const user = await this.userRepository.findByUsername(author);
      if (user) whereObj.userId = user.id;
      else return [];
    }

    function subQueryBuilderFromTagId(
      tagId: number,
      qb: SelectQueryBuilder<unknown>
    ) {
      return qb
        .subQuery()
        .from(Tag, "t")
        .select("t_q.post_question_id", "qid")
        .where(`t.id=${tagId}`)
        .leftJoin(PostQuestionHasTag, "t_q", "t.id=t_q.tag_id");
    }

    if (tagIDs && tagIDs.length) {
      let tagQueryBuilder = createQueryBuilder()
        .select("t0.qid")
        .from((qb) => subQueryBuilderFromTagId(tagIDs[0], qb), "t0");

      for (let i = 1; i < tagIDs.length; i++) {
        tagQueryBuilder.innerJoin(
          (qb) => subQueryBuilderFromTagId(tagIDs[i], qb),
          // alias
          `t${i}`,
          // ON
          `t0.qid=t${i}.qid`
        );
      }

      const qidArray = (await tagQueryBuilder.getRawMany()).map(
        (qid) => qid.qid
      );
      whereObj.id = In(qidArray);
    }

    const builder = this.questionRepository
      .createQueryBuilder()
      .where(whereObj)
      .skip(skip ?? 0)
      .take(take ?? PostService.DEFALUT_TAKE_QUESTIONS_COUNT)
      .orderBy("id", "DESC");

    const rows = await builder.getMany();
    return rows;
  }

  public async findAllQuestionByUserId(
    userId: number
  ): Promise<PostQuestion[]> {
    const questions = await this.questionRepository.find({ userId });

    return questions;
  }

  public async findAllAnswerByUserId(userId: number): Promise<PostAnswer[]> {
    const data = await this.answerRepository.find({ userId });
    return data;
  }

  public async findAllAnswerByQuestionId(id: number): Promise<PostAnswer[]> {
    const data = await this.answerRepository.find({ postQuestionId: id });

    return data;
  }

  public async findOneQuestionById(id: number): Promise<PostQuestion> {
    const question = await this.questionRepository.findOne({ id: id });

    if (!question) throw new NoSuchQuestionError("Check ID");

    return question;
  }

  public async viewOneQuestionById(id: number): Promise<PostQuestion> {
    const question = await this.questionRepository.findOneQuestionById(id);

    if (!question) throw new NoSuchQuestionError("Check ID");
    question.viewCount++;
    const viewedQuestion = await this.questionRepository.save(question);

    return viewedQuestion;
  }

  public async addNewQuestion(
    args: QuestionInput,
    // 이후 ctx.user 로 수정
    userId: number
  ): Promise<PostQuestion> {
    const newQuestion = new PostQuestion();
    newQuestion.userId = userId;
    newQuestion.title = args.title;
    newQuestion.desc = args.desc;
    newQuestion.realtimeShare = args.realtimeShare ? 1 : 0;
    await this.questionRepository.save(newQuestion);

    const author = await this.userRepository.findById(userId);
    if (args.tagIds && args.tagIds.length > 0) {
      for (const tagId of args.tagIds) {
        const postQuestionHasTag = new PostQuestionHasTag();
        postQuestionHasTag.postQuestion = newQuestion;
        postQuestionHasTag.tagId = tagId;
        this.postQuestionHasTagRepository.create(postQuestionHasTag);

        // 유저 개인의 태그 저장
        let userHasTag = await this.userHasTagRepository.findOne({
          userId: userId,
          tagId: tagId,
        });
        if (!userHasTag) {
          userHasTag = new UserHasTag();
          userHasTag.user = author;
          userHasTag.tagId = tagId;
          userHasTag.count = 0;
        } else {
          userHasTag.count++;
        }

        this.userHasTagRepository.save(userHasTag);
      }
    }

    return newQuestion;
  }

  public async updateQuestion(
    questionId: number,
    fieldsToUpdate: Partial<QuestionInput>
  ) {
    const partialQuestion: PostQuestion = new PostQuestion();
    const originQuestion = await this.questionRepository.findOneQuestionById(
      questionId
    );
    partialQuestion.id = questionId;
    partialQuestion.userId = originQuestion.userId;
    partialQuestion.title = fieldsToUpdate.title;
    partialQuestion.desc = fieldsToUpdate.desc;
    partialQuestion.realtimeShare = fieldsToUpdate.realtimeShare ? 1 : 0;

    if (fieldsToUpdate.tagIds && fieldsToUpdate.tagIds.length > 0) {
      await this.postQuestionHasTagRepository.delete({
        postQuestionId: questionId,
      });

      for (const tagId of fieldsToUpdate.tagIds) {
        const tagEntity = new PostQuestionHasTag();
        tagEntity.postQuestion = partialQuestion;
        tagEntity.tagId = tagId;
        this.postQuestionHasTagRepository.save(tagEntity);
      }
    }

    return await this.questionRepository.save(partialQuestion);
  }

  public async deleteQuestion(questionId: number): Promise<boolean> {
    const result = await this.questionRepository.deleteById(questionId);
    await this.questionThumbRepository.deleteByQuestionId(questionId);

    return result;
  }

  public async getAnswerCount(questionId: number): Promise<number> {
    const question = await this.questionRepository.findOneQuestionById(
      questionId
    );
    if (!question) throw new NoSuchQuestionError();

    const count = await this.answerRepository.count({
      postQuestionId: questionId,
    });

    return count;
  }

  public async addNewAnswer(
    args: AnswerInput,
    userId: number,
    questionId: number
  ): Promise<PostAnswer> {
    const question = await this.questionRepository.findOneQuestionById(
      questionId
    );
    const newAnswer = new PostAnswer();
    newAnswer.postQuestionId = question.id;
    newAnswer.postQuestionUserId = question.userId;
    newAnswer.userId = userId;
    newAnswer.desc = args.desc;

    const author = await this.userRepository.findById(userId);
    author.score += 10;
    await this.userRepository.save(author);

    return await this.answerRepository.save(newAnswer);
  }

  public async findOneAnswerById(answerId: number): Promise<PostAnswer> {
    const answer = await this.answerRepository.findOneAnswerById(answerId);

    return answer;
  }

  public async updateAnswer(
    answerId: number,
    answerInput: AnswerInput
  ): Promise<PostAnswer> {
    const answer = await this.answerRepository.findOneAnswerById(answerId);
    answer.desc = answerInput.desc;

    return await this.answerRepository.save(answer);
  }

  public async deleteAnswer(answerId: number): Promise<boolean> {
    await this.answerRepository.deleteById(answerId);
    await this.answerThumbRepository.deleteByAnswerId(answerId);

    return true;
  }

  public async adoptAnswer(userId: number, answerId: number): Promise<boolean> {
    const answer = await this.answerRepository.findOneAnswerById(answerId);
    const answerAuthor = await this.userRepository.findById(answer.userId);
    const question = await this.questionRepository.findOneQuestionById(
      answer.postQuestionId
    );

    if (answer.postQuestionUserId !== userId)
      throw new AuthorizationError(
        "you don't have permission! It is not your question."
      );

    if (answer.userId === userId)
      throw new CommonError("you can't adopt your answer");

    if (question.adopted === 1)
      throw new CommonError("question already adopted another answer");

    if (answer.state === 0) {
      question.adopted = 1;
      answer.state = 1;
      answerAuthor.score += 50;
      await this.answerRepository.save(answer);
      await this.userRepository.save(answerAuthor);
      await this.questionRepository.save(question);
      return true;
    } else {
      return false;
    }
  }
 public async turnOffRealtimeShare(userId: number, questionId: number) {
    const question = await this.questionRepository.findOneQuestionById(
      questionId
    );

    if (question.userId !== userId)
    if (question.realtimeShare === 0)
      throw new CommonError("realtime share is already disabled");

    question.realtimeShare = 0;
    await this.questionRepository.save(question);

    return true;
  }
}
